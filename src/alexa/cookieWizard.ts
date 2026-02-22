import os from "node:os";
import { AppError } from "../errors";
import { SetupService } from "../setup";
import { logger } from "../logger";

// alexa-cookie2 exports a singleton instance.
import alexaCookie from "alexa-cookie2";

type WizardStatus =
  | "idle"
  | "starting"
  | "awaiting_login"
  | "saving_cookie"
  | "completed"
  | "failed"
  | "stopped";

interface WizardState {
  status: WizardStatus;
  message: string;
  loginUrl: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  proxyHost: string | null;
  proxyPort: number | null;
  amazonPage: string | null;
  baseAmazonPage: string | null;
  acceptLanguage: string | null;
  cookieMode: "plain" | "encrypted" | null;
}

interface StartWizardInput {
  proxyHost: string;
  proxyPort: number;
  amazonPage: string;
  baseAmazonPage: string;
  acceptLanguage: string;
  preferEncrypted: boolean;
}

interface AlexaCookieResult {
  localCookie?: string;
  loginCookie?: string;
  cookie?: string;
}

interface WizardOptions {
  timeoutMs: number;
  mockMode: boolean;
}

interface AlexaCookieApi {
  generateAlexaCookie: (
    options: Record<string, unknown>,
    callback: (err: Error | null, result: AlexaCookieResult | null) => void,
  ) => void;
  stopProxyServer: (callback?: () => void) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function extractLoginUrl(message: string): string | null {
  const match = message.match(/http:\/\/[^\s]+/i);
  if (!match) {
    return null;
  }
  return match[0];
}

function preferredExternalIp(): string {
  const networks = os.networkInterfaces();
  for (const entries of Object.values(networks)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

export class AlexaCookieWizardService {
  private readonly setupService: SetupService;
  private readonly options: WizardOptions;
  private readonly cookieApi: AlexaCookieApi;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private runId = 0;

  private state: WizardState = {
    status: "idle",
    message: "Wizard not started",
    loginUrl: null,
    error: null,
    startedAt: null,
    updatedAt: nowIso(),
    proxyHost: null,
    proxyPort: null,
    amazonPage: null,
    baseAmazonPage: null,
    acceptLanguage: null,
    cookieMode: null,
  };

  constructor(setupService: SetupService, options: WizardOptions, cookieApi?: AlexaCookieApi) {
    this.setupService = setupService;
    this.options = options;
    this.cookieApi = cookieApi ?? (alexaCookie as unknown as AlexaCookieApi);
  }

  getStatus(): WizardState {
    return { ...this.state };
  }

  async start(input: StartWizardInput): Promise<WizardState> {
    if (this.state.status === "starting" || this.state.status === "awaiting_login" || this.state.status === "saving_cookie") {
      throw new AppError(409, "BAD_REQUEST", "Alexa cookie wizard is already running");
    }

    this.runId += 1;
    const currentRun = this.runId;

    const proxyHost = input.proxyHost.trim() || preferredExternalIp();
    const proxyPort = input.proxyPort;

    this.setState({
      status: "starting",
      message: "Starting Alexa login proxy ...",
      loginUrl: null,
      error: null,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      proxyHost,
      proxyPort,
      amazonPage: input.amazonPage,
      baseAmazonPage: input.baseAmazonPage,
      acceptLanguage: input.acceptLanguage,
      cookieMode: null,
    });

    this.clearTimeout();
    this.timeoutHandle = setTimeout(() => {
      if (this.runId !== currentRun) {
        return;
      }
      this.finishFailed(
        "Wizard timeout reached. Start the wizard again and complete the Amazon login faster.",
      );
      this.stopProxy();
    }, this.options.timeoutMs);
    this.timeoutHandle.unref();

    if (this.options.mockMode) {
      const loginUrl = `http://${proxyHost}:${proxyPort}/`;
      this.setState({
        status: "awaiting_login",
        message: "Mock wizard started. Open the URL and wait for auto completion.",
        loginUrl,
        updatedAt: nowIso(),
      });

      setTimeout(() => {
        if (this.runId !== currentRun) {
          return;
        }
        try {
          this.setState({
            status: "saving_cookie",
            message: "Saving mock cookie ...",
            updatedAt: nowIso(),
          });
          const saved = this.setupService.setAlexaCookie("session-id=mock-cookie; ubid-main=mock", false);
          this.setState({
            status: "completed",
            message: `Mock cookie saved (${saved.mode}). Restart AirBridge to apply.`,
            cookieMode: saved.mode,
            updatedAt: nowIso(),
          });
        } catch (error) {
          this.finishFailed(error instanceof Error ? error.message : String(error));
        }
      }, 1500).unref();

      return this.getStatus();
    }

    const options = {
      logger: (msg: string) => logger.info("alexa-cookie2", { msg }),
      proxyOnly: true,
      setupProxy: true,
      proxyOwnIp: proxyHost,
      proxyPort,
      proxyListenBind: "0.0.0.0",
      amazonPage: input.amazonPage,
      baseAmazonPage: input.baseAmazonPage,
      acceptLanguage: input.acceptLanguage,
      amazonPageProxyLanguage: input.acceptLanguage.replace("-", "_"),
      proxyLogLevel: "warn",
      proxyCloseWindowHTML:
        "<h2>AirBridge: Alexa login complete.</h2><p>You can close this window and return to the AirBridge setup wizard.</p>",
    };

    this.cookieApi.generateAlexaCookie(options, (err, result) => {
      if (this.runId !== currentRun) {
        return;
      }

      if (err) {
        const errMsg = err.message || String(err);
        const loginUrl = extractLoginUrl(errMsg);

        if (loginUrl) {
          this.setState({
            status: "awaiting_login",
            message: "Open the login URL and sign in to Amazon. The wizard stores the cookie automatically.",
            loginUrl,
            error: null,
            updatedAt: nowIso(),
          });
          return;
        }

        this.finishFailed(errMsg);
        this.stopProxy();
        return;
      }

      const cookie = (result?.localCookie || result?.loginCookie || result?.cookie || "").trim();
      if (!cookie) {
        this.finishFailed("Cookie retrieval finished but no cookie was returned.");
        this.stopProxy();
        return;
      }

      try {
        this.setState({
          status: "saving_cookie",
          message: "Cookie received. Saving setup ...",
          updatedAt: nowIso(),
        });
        const saved = this.setupService.setAlexaCookie(cookie, input.preferEncrypted);
        this.setState({
          status: "completed",
          message: `Cookie saved (${saved.mode}). Restart AirBridge to apply.`,
          cookieMode: saved.mode,
          updatedAt: nowIso(),
        });
      } catch (saveError) {
        this.finishFailed(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        this.stopProxy();
      }
    });

    return this.getStatus();
  }

  stop(): WizardState {
    this.runId += 1;
    this.clearTimeout();
    this.stopProxy();

    this.setState({
      status: "stopped",
      message: "Wizard stopped by user.",
      loginUrl: null,
      error: null,
      updatedAt: nowIso(),
    });

    return this.getStatus();
  }

  private finishFailed(errorMessage: string): void {
    this.clearTimeout();
    this.setState({
      status: "failed",
      message: "Alexa cookie wizard failed.",
      error: errorMessage,
      updatedAt: nowIso(),
    });
  }

  private stopProxy(): void {
    try {
      this.cookieApi.stopProxyServer();
    } catch {
      // Ignore cleanup issues.
    }
    this.clearTimeout();
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private setState(next: Partial<WizardState>): void {
    this.state = {
      ...this.state,
      ...next,
    };
  }
}
