import fs from "node:fs";
import AlexaRemote from "alexa-remote2";
import { Target } from "../types";

interface InvokeError extends Error {
  code?: string;
}

function codeError(code: string, message: string): InvokeError {
  const err = new Error(message) as InvokeError;
  err.code = code;
  return err;
}

export class AlexaAdapter {
  private readonly mode: string;
  private readonly cookiePath?: string;
  private readonly invocationPrefix: string;
  private readonly initTimeoutMs: number;
  private remote: AlexaRemote | null = null;
  private initialized = false;

  constructor(params: {
    mode: string;
    cookiePath?: string;
    invocationPrefix?: string;
    initTimeoutMs?: number;
  }) {
    this.mode = params.mode;
    this.cookiePath = params.cookiePath;
    this.invocationPrefix = params.invocationPrefix ?? "open air bridge and play token";
    this.initTimeoutMs = params.initTimeoutMs ?? 15_000;
  }

  async init(): Promise<void> {
    if (this.mode === "mock") {
      this.initialized = true;
      return;
    }

    if (this.mode !== "alexa_remote2") {
      throw codeError("ALEXA_AUTH_FAILED", `Unsupported Alexa mode: ${this.mode}`);
    }

    if (!this.cookiePath) {
      throw codeError("ALEXA_AUTH_FAILED", "AIRBRIDGE_ALEXA_COOKIE_PATH is required");
    }

    if (!fs.existsSync(this.cookiePath)) {
      throw codeError("ALEXA_AUTH_FAILED", `Alexa cookie file not found: ${this.cookiePath}`);
    }

    const cookieContent = fs.readFileSync(this.cookiePath, "utf8").trim();
    if (!cookieContent) {
      throw codeError("ALEXA_AUTH_FAILED", "Alexa cookie file is empty");
    }

    this.remote = new AlexaRemote();

    try {
      await this.initWithTimeout(cookieContent);
      this.initialized = true;
    } catch (error) {
      this.remote = null;
      this.initialized = false;
      throw error;
    }
  }

  async invokeStream(target: Target, streamToken: string, streamUrl: string): Promise<void> {
    if (!this.initialized) {
      throw codeError("ALEXA_AUTH_FAILED", "Alexa adapter is not initialized");
    }

    if (this.mode === "mock") {
      return;
    }

    if (!this.remote) {
      throw codeError("ALEXA_AUTH_FAILED", "Alexa remote client is missing");
    }

    if (!target.alexa_device_id) {
      throw codeError("ALEXA_INVOKE_FAILED", "Target has no alexa_device_id");
    }

    const utterance = `${this.invocationPrefix} ${streamToken}`;

    await new Promise<void>((resolve, reject) => {
      this.remote?.sendSequenceCommand(
        target.alexa_device_id as string,
        "textCommand",
        utterance,
        (err: Error | null | undefined) => {
          if (err) {
            reject(codeError("ALEXA_INVOKE_FAILED", err.message));
            return;
          }
          resolve();
        },
      );
    });

    void streamUrl;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private async initWithTimeout(cookieContent: string): Promise<void> {
    const initPromise = new Promise<void>((resolve, reject) => {
      this.remote?.init(
        {
          cookie: cookieContent,
          proxyOnly: true,
          bluetooth: false,
          notifications: false,
          useWsMqtt: true,
          cookieRefreshInterval: 0,
        },
        (err: Error | null | undefined) => {
          if (err) {
            reject(codeError("ALEXA_AUTH_FAILED", err.message));
            return;
          }
          resolve();
        },
      );
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          codeError(
            "ALEXA_AUTH_FAILED",
            `Alexa adapter init timeout after ${this.initTimeoutMs}ms`,
          ),
        );
      }, this.initTimeoutMs);
      timer.unref();
      initPromise.finally(() => clearTimeout(timer));
    });

    await Promise.race([initPromise, timeoutPromise]);
  }
}
