import fs from "node:fs";
import AlexaRemote from "alexa-remote2";
import { Target } from "../types";

interface InvokeError extends Error {
  code?: string;
}

export interface AlexaDeviceSummary {
  serialNumber: string;
  name: string;
  deviceFamily: string;
}

interface AlexaHttpDeviceContext {
  serialNumber: string;
  deviceType: string;
  customerId: string;
  locale: string;
  host: string;
}

function codeError(code: string, message: string): InvokeError {
  const err = new Error(message) as InvokeError;
  err.code = code;
  return err;
}

function extractCsrf(cookieContent: string): string | null {
  const match = cookieContent.match(/(?:^|;\s*)csrf=([^;]+)/i);
  if (!match) {
    return null;
  }

  const token = decodeURIComponent(match[1]).replace(/^"(.*)"$/, "$1").trim();
  return token || null;
}

function inferAlexaHosts(cookieContent: string): string[] {
  const hosts: string[] = [];

  const marketHints: Array<{ pattern: RegExp; host: string }> = [
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-acbde=/i, host: "alexa.amazon.de" },
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-acbuk=/i, host: "alexa.amazon.co.uk" },
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-acbfr=/i, host: "alexa.amazon.fr" },
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-acbit=/i, host: "alexa.amazon.it" },
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-acbes=/i, host: "alexa.amazon.es" },
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-acbjp=/i, host: "alexa.amazon.co.jp" },
    { pattern: /(?:^|;\s*)(?:at|sess-at|ubid|x)-main=/i, host: "alexa.amazon.com" },
  ];

  for (const hint of marketHints) {
    if (hint.pattern.test(cookieContent)) {
      hosts.push(hint.host);
    }
  }

  hosts.push(
    "alexa.amazon.com",
    "alexa.amazon.de",
    "alexa.amazon.co.uk",
    "alexa.amazon.fr",
    "alexa.amazon.it",
    "alexa.amazon.es",
    "alexa.amazon.co.jp",
  );

  return Array.from(new Set(hosts));
}

function defaultLocaleForHost(host: string): string {
  if (host.endsWith(".amazon.de")) {
    return "de-DE";
  }
  if (host.endsWith(".amazon.co.uk")) {
    return "en-GB";
  }
  if (host.endsWith(".amazon.fr")) {
    return "fr-FR";
  }
  if (host.endsWith(".amazon.it")) {
    return "it-IT";
  }
  if (host.endsWith(".amazon.es")) {
    return "es-ES";
  }
  if (host.endsWith(".amazon.co.jp")) {
    return "ja-JP";
  }
  return "en-US";
}

export class AlexaAdapter {
  private readonly mode: string;
  private readonly cookiePath?: string;
  private readonly invocationPrefix: string;
  private readonly initTimeoutMs: number;
  private remote: AlexaRemote | null = null;
  private initialized = false;
  private initInFlight: Promise<void> | null = null;

  constructor(params: {
    mode: string;
    cookiePath?: string;
    invocationPrefix?: string;
    initTimeoutMs?: number;
  }) {
    this.mode = params.mode;
    this.cookiePath = params.cookiePath;
    this.invocationPrefix = params.invocationPrefix ?? "ask air bridge to play token";
    this.initTimeoutMs = params.initTimeoutMs ?? 15_000;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initInFlight) {
      await this.initInFlight;
      return;
    }

    this.initInFlight = this.initInternal();
    try {
      await this.initInFlight;
    } finally {
      this.initInFlight = null;
    }
  }

  private async initInternal(): Promise<void> {
    if (this.mode === "mock") {
      this.initialized = true;
      return;
    }

    if (this.mode !== "alexa_remote2") {
      throw codeError("ALEXA_AUTH_FAILED", `Unsupported Alexa mode: ${this.mode}`);
    }

    const cookieContent = this.readCookieContent();

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
    if (this.mode === "mock") {
      return;
    }

    if (!target.alexa_device_id) {
      throw codeError("ALEXA_INVOKE_FAILED", "Target has no alexa_device_id");
    }

    const utterance = `${this.invocationPrefix} ${streamToken}`;
    let lastError: string | null = null;

    if (!this.initialized) {
      try {
        await this.init();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (this.initialized && this.remote) {
      try {
        await this.sendViaRemote(target.alexa_device_id, utterance);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      await this.sendViaHttp(target.alexa_device_id, utterance);
      return;
    } catch (error) {
      const httpError = error instanceof Error ? error.message : String(error);
      const message = lastError
        ? `${lastError}; HTTP fallback failed: ${httpError}`
        : httpError;
      throw codeError("ALEXA_AUTH_FAILED", message);
    }
  }

  private async sendViaRemote(deviceSerial: string, utterance: string): Promise<void> {
    if (!this.remote) {
      throw codeError("ALEXA_AUTH_FAILED", "Alexa remote client is missing");
    }

    await new Promise<void>((resolve, reject) => {
      this.remote?.sendSequenceCommand(
        deviceSerial,
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
  }

  private async sendViaHttp(deviceSerial: string, utterance: string): Promise<void> {
    const cookieContent = this.readCookieContent();
    const csrf = extractCsrf(cookieContent);
    if (!csrf) {
      throw new Error("Alexa cookie does not contain csrf token");
    }

    const context = await this.resolveHttpDeviceContext(deviceSerial, cookieContent);
    const requestBody = {
      behaviorId: "PREVIEW",
      sequenceJson: JSON.stringify({
        "@type": "com.amazon.alexa.behaviors.model.Sequence",
        startNode: {
          "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
          type: "Alexa.TextCommand",
          skillId: "amzn1.ask.1p.tellalexa",
          operationPayload: {
            deviceType: context.deviceType,
            deviceSerialNumber: context.serialNumber,
            locale: context.locale,
            customerId: context.customerId,
            text: utterance.toLowerCase(),
          },
        },
      }),
      status: "ENABLED",
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.initTimeoutMs, 20_000));
    timer.unref();

    try {
      const response = await fetch(`https://${context.host}/api/behaviors/preview`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie: cookieContent,
          csrf,
          "x-csrf-token": csrf,
          referer: `https://${context.host}/spa/index.html`,
          origin: `https://${context.host}`,
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${context.host} preview failed with ${response.status}: ${text.slice(0, 240)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${context.host} preview request timeout`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async listDevices(): Promise<AlexaDeviceSummary[]> {
    if (this.mode === "mock") {
      return [];
    }

    if (this.initialized && this.remote) {
      try {
        const rawDevices = await this.loadDevicesFromRemote();
        const byRemote = this.normalizeDeviceList(rawDevices);
        if (byRemote.length > 0) {
          return byRemote;
        }
      } catch {
        // Fall back to direct HTTP query with stored cookie.
      }
    }

    const cookieContent = this.readCookieContent();
    return this.loadDevicesFromHttp(cookieContent);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private readCookieContent(): string {
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

    return cookieContent;
  }

  private async loadDevicesFromRemote(): Promise<unknown[]> {
    if (!this.remote) {
      throw codeError("ALEXA_AUTH_FAILED", "Alexa remote client is missing");
    }

    const remote = this.remote as unknown as {
      getDevices: (callback: (err: Error | null | undefined, devices: unknown) => void) => void;
    };

    const rawDevices = await new Promise<unknown>((resolve, reject) => {
      remote.getDevices((err: Error | null | undefined, devices: unknown) => {
        if (err) {
          reject(codeError("ALEXA_INVOKE_FAILED", err.message));
          return;
        }
        resolve(devices);
      });
    });

    return Array.isArray(rawDevices)
      ? rawDevices
      : rawDevices && typeof rawDevices === "object"
        ? Object.values(rawDevices as Record<string, unknown>)
        : [];
  }

  private async resolveHttpDeviceContext(
    deviceSerial: string,
    cookieContent: string,
  ): Promise<AlexaHttpDeviceContext> {
    const hosts = inferAlexaHosts(cookieContent);
    let lastError = "device not found";

    for (const host of hosts) {
      try {
        const csrf = extractCsrf(cookieContent);
        if (!csrf) {
          throw new Error("csrf token missing");
        }

        const entries = await this.fetchDeviceEntries(host, cookieContent, csrf);
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") {
            continue;
          }

          const candidate = entry as Record<string, unknown>;
          const serialNumber = this.readStringField(candidate, [
            "serialNumber",
            "deviceSerialNumber",
          ]);
          if (!serialNumber || serialNumber !== deviceSerial) {
            continue;
          }

          const deviceType = this.readStringField(candidate, ["deviceType", "deviceTypeId"]);
          const customerId = this.readStringField(candidate, [
            "deviceOwnerCustomerId",
            "customerId",
            "ownerCustomerId",
          ]);

          if (!deviceType || !customerId) {
            throw new Error(`missing deviceType/customerId for ${deviceSerial}`);
          }

          const locale =
            this.readStringField(candidate, ["locale", "localeCode"]) ?? defaultLocaleForHost(host);

          return {
            serialNumber,
            deviceType,
            customerId,
            locale,
            host,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`No Alexa command context for ${deviceSerial}: ${lastError}`);
  }

  private readStringField(
    source: Record<string, unknown>,
    keys: string[],
  ): string | null {
    for (const key of keys) {
      const value = source[key];
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return null;
  }

  private normalizeDeviceList(rawEntries: unknown[]): AlexaDeviceSummary[] {
    const seen = new Set<string>();
    const summaries: AlexaDeviceSummary[] = [];

    for (const entry of rawEntries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const candidate = entry as Record<string, unknown>;
      const serialRaw = candidate.serialNumber;
      if (typeof serialRaw !== "string") {
        continue;
      }

      const serialNumber = serialRaw.trim();
      if (!serialNumber || seen.has(serialNumber)) {
        continue;
      }
      seen.add(serialNumber);

      const accountName =
        typeof candidate.accountName === "string" ? candidate.accountName.trim() : "";
      const friendlyName =
        typeof candidate.deviceTypeFriendlyName === "string"
          ? candidate.deviceTypeFriendlyName.trim()
          : "";
      const deviceFamily =
        typeof candidate.deviceFamily === "string" ? candidate.deviceFamily.trim() : "unknown";

      const name =
        accountName || friendlyName || `Alexa ${serialNumber.slice(Math.max(0, serialNumber.length - 6))}`;

      summaries.push({
        serialNumber,
        name,
        deviceFamily,
      });
    }

    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return summaries;
  }

  private async loadDevicesFromHttp(cookieContent: string): Promise<AlexaDeviceSummary[]> {
    const csrf = extractCsrf(cookieContent);
    if (!csrf) {
      throw codeError("ALEXA_AUTH_FAILED", "Alexa cookie does not contain csrf token");
    }

    const hosts = inferAlexaHosts(cookieContent);
    let lastError = "unknown error";

    for (const host of hosts) {
      try {
        const entries = await this.fetchDeviceEntries(host, cookieContent, csrf);
        const normalized = this.normalizeDeviceList(entries);
        if (normalized.length > 0) {
          return normalized;
        }
        lastError = `${host} returned no devices`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw codeError("ALEXA_AUTH_FAILED", `Unable to fetch Alexa devices: ${lastError}`);
  }

  private async fetchDeviceEntries(
    host: string,
    cookieContent: string,
    csrf: string,
  ): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.initTimeoutMs, 15_000));
    timer.unref();

    try {
      const response = await fetch(`https://${host}/api/devices-v2/device?cached=false`, {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: cookieContent,
          csrf,
          "x-csrf-token": csrf,
          referer: `https://${host}/spa/index.html`,
          origin: `https://${host}`,
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${host} responded with status ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        return payload;
      }
      if (!payload || typeof payload !== "object") {
        return [];
      }

      const record = payload as Record<string, unknown>;
      if (Array.isArray(record.devices)) {
        return record.devices;
      }
      if (Array.isArray(record.deviceList)) {
        return record.deviceList;
      }
      if (Array.isArray(record.data)) {
        return record.data;
      }
      return [];
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${host} request timeout`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async initWithTimeout(cookieContent: string): Promise<void> {
    const initPromise = new Promise<void>((resolve, reject) => {
      this.remote?.init(
        {
          cookie: cookieContent,
          // Runtime client must not run in proxy-only mode.
          proxyOnly: false,
          bluetooth: false,
          notifications: false,
          // We only need command APIs; WS-MQTT can stall init on some networks.
          useWsMqtt: false,
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
