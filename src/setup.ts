import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import argon2 from "argon2";
import { AppError } from "./errors";

const ALLOWED_ENV_KEYS = [
  "AIRBRIDGE_BIND_HOST",
  "AIRBRIDGE_PORT",
  "AIRBRIDGE_TRUST_PROXY",
  "AIRBRIDGE_STREAM_BASE_URL",
  "AIRBRIDGE_ADMIN_USER",
  "AIRBRIDGE_SESSION_SECRET",
  "AIRBRIDGE_SESSION_TTL_SECONDS",
  "AIRBRIDGE_AUTH_RATE_LIMIT",
  "AIRBRIDGE_ALEXA_INVOKE_MODE",
  "AIRBRIDGE_ALEXA_INVOCATION_PREFIX",
  "AIRBRIDGE_ALEXA_COOKIE_PATH",
  "AIRBRIDGE_SHAIRPORT_BIN",
  "AIRBRIDGE_FFMPEG_BIN",
  "AIRBRIDGE_FFMPEG_BITRATE",
  "AIRBRIDGE_SPAWN_PROCESSES",
  "AIRBRIDGE_HLS_SEGMENT_SECONDS",
  "AIRBRIDGE_HLS_LIST_SIZE",
  "AIRBRIDGE_MONITOR_INTERVAL_MS",
  "AIRBRIDGE_DATA_ROOT",
  "AIRBRIDGE_RUN_ROOT",
  "AIRBRIDGE_HLS_ROOT",
  "AIRBRIDGE_DB_PATH",
  "AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION",
] as const;

type AllowedKey = (typeof ALLOWED_ENV_KEYS)[number];

interface SetupServiceOptions {
  envFilePath: string;
  cloudflaredConfigPath: string;
  plainAlexaCookiePath: string;
  encryptedAlexaCookiePath: string;
  serviceName: string;
  cloudflaredServiceName: string;
  allowCredentialEncryption: boolean;
}

interface ServiceState {
  active: "active" | "inactive" | "failed" | "unknown";
  enabled: "enabled" | "disabled" | "unknown";
}

interface SetupStatus {
  envFilePath: string;
  cloudflaredConfigPath: string;
  plainAlexaCookiePath: string;
  encryptedAlexaCookiePath: string;
  envFileExists: boolean;
  cloudflaredConfigExists: boolean;
  plainCookieExists: boolean;
  encryptedCookieExists: boolean;
  envWritable: boolean;
  cloudflaredWritable: boolean;
  plainCookieWritable: boolean;
  encryptedCookieWritable: boolean;
  hasAdminPasswordHash: boolean;
  hasSessionSecret: boolean;
  allowCredentialEncryption: boolean;
  services: {
    airbridge: ServiceState;
    cloudflared: ServiceState;
  };
}

interface SetupConfigResult {
  values: Record<string, string>;
  cloudflaredConfig: string;
}

function isWritable(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      fs.accessSync(filePath, fs.constants.W_OK);
      return true;
    }
    const dir = path.dirname(filePath);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeEnvValue(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return String(input);
  }
  throw new AppError(400, "BAD_REQUEST", "Only string/number/boolean values are supported");
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value.replace(/\n/g, "\\n"));
}

export class SetupService {
  private readonly options: SetupServiceOptions;

  constructor(options: SetupServiceOptions) {
    this.options = options;
  }

  getAllowedKeys(): readonly AllowedKey[] {
    return ALLOWED_ENV_KEYS;
  }

  getStatus(runtimeFallback: { hasAdminPasswordHash: boolean; hasSessionSecret: boolean }): SetupStatus {
    const envMap = this.readEnvMap();

    return {
      envFilePath: this.options.envFilePath,
      cloudflaredConfigPath: this.options.cloudflaredConfigPath,
      plainAlexaCookiePath: this.options.plainAlexaCookiePath,
      encryptedAlexaCookiePath: this.options.encryptedAlexaCookiePath,
      envFileExists: fs.existsSync(this.options.envFilePath),
      cloudflaredConfigExists: fs.existsSync(this.options.cloudflaredConfigPath),
      plainCookieExists: fs.existsSync(this.options.plainAlexaCookiePath),
      encryptedCookieExists: fs.existsSync(this.options.encryptedAlexaCookiePath),
      envWritable: isWritable(this.options.envFilePath),
      cloudflaredWritable: isWritable(this.options.cloudflaredConfigPath),
      plainCookieWritable: isWritable(this.options.plainAlexaCookiePath),
      encryptedCookieWritable: isWritable(this.options.encryptedAlexaCookiePath),
      hasAdminPasswordHash:
        Boolean(envMap.AIRBRIDGE_ADMIN_PASSWORD_HASH && envMap.AIRBRIDGE_ADMIN_PASSWORD_HASH.length > 16) ||
        runtimeFallback.hasAdminPasswordHash,
      hasSessionSecret:
        Boolean(envMap.AIRBRIDGE_SESSION_SECRET && envMap.AIRBRIDGE_SESSION_SECRET.length > 12) ||
        runtimeFallback.hasSessionSecret,
      allowCredentialEncryption: this.options.allowCredentialEncryption,
      services: {
        airbridge: this.getServiceState(this.options.serviceName),
        cloudflared: this.getServiceState(this.options.cloudflaredServiceName),
      },
    };
  }

  getConfig(currentEnv: NodeJS.ProcessEnv): SetupConfigResult {
    const envMap = this.readEnvMap();
    const values: Record<string, string> = {};

    for (const key of ALLOWED_ENV_KEYS) {
      values[key] = envMap[key] ?? currentEnv[key] ?? "";
    }

    let cloudflaredConfig = "";
    if (fs.existsSync(this.options.cloudflaredConfigPath)) {
      cloudflaredConfig = fs.readFileSync(this.options.cloudflaredConfigPath, "utf8");
    }

    return {
      values,
      cloudflaredConfig,
    };
  }

  updateConfig(values: Record<string, unknown>): SetupConfigResult {
    const envMap = this.readEnvMap();

    for (const [rawKey, rawValue] of Object.entries(values)) {
      const key = rawKey as AllowedKey;
      if (!ALLOWED_ENV_KEYS.includes(key)) {
        throw new AppError(400, "BAD_REQUEST", `Unsupported setup key: ${rawKey}`);
      }
      envMap[key] = normalizeEnvValue(rawValue);
    }

    if (!envMap.AIRBRIDGE_SESSION_SECRET) {
      envMap.AIRBRIDGE_SESSION_SECRET = randomBytes(32).toString("hex");
    }

    this.writeEnvMap(envMap);
    return this.getConfig(process.env);
  }

  async setAdminPassword(password: string): Promise<void> {
    if (password.length < 8) {
      throw new AppError(400, "BAD_REQUEST", "Password must be at least 8 characters");
    }

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const envMap = this.readEnvMap();
    envMap.AIRBRIDGE_ADMIN_PASSWORD_HASH = hash;
    delete envMap.AIRBRIDGE_ADMIN_PASSWORD;
    this.writeEnvMap(envMap);
  }

  setCloudflaredConfig(content: string): void {
    fs.mkdirSync(path.dirname(this.options.cloudflaredConfigPath), { recursive: true });
    fs.writeFileSync(this.options.cloudflaredConfigPath, `${content.trim()}\n`, "utf8");
  }

  setAlexaCookie(cookieContent: string, preferEncrypted: boolean): { mode: "encrypted" | "plain"; path: string } {
    const cookie = cookieContent.trim();
    if (!cookie) {
      throw new AppError(400, "BAD_REQUEST", "Cookie content cannot be empty");
    }

    // Keep setup robust by default: plain cookie file path is always directly readable by the service.
    void preferEncrypted;

    fs.mkdirSync(path.dirname(this.options.plainAlexaCookiePath), { recursive: true });
    fs.writeFileSync(this.options.plainAlexaCookiePath, `${cookie}\n`, "utf8");

    const envMap = this.readEnvMap();
    envMap.AIRBRIDGE_ALEXA_COOKIE_PATH = this.options.plainAlexaCookiePath;
    envMap.AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION = "false";
    this.writeEnvMap(envMap);

    return {
      mode: "plain",
      path: this.options.plainAlexaCookiePath,
    };
  }

  scheduleSelfRestart(delayMs = 500): void {
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, delayMs).unref();
  }

  private tryWriteEncryptedCookie(cookie: string): { ok: boolean; error?: string } {
    const tempFile = path.join(os.tmpdir(), `airbridge-cookie-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, `${cookie}\n`, "utf8");

    try {
      fs.mkdirSync(path.dirname(this.options.encryptedAlexaCookiePath), { recursive: true });
      const result = spawnSync(
        "systemd-creds",
        ["encrypt", "--name=airbridge_alexa_cookie", tempFile, this.options.encryptedAlexaCookiePath],
        {
          encoding: "utf8",
        },
      );

      if (result.status !== 0) {
        return {
          ok: false,
          error: (result.stderr || result.stdout || "systemd-creds failed").trim(),
        };
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  private readEnvMap(): Record<string, string> {
    if (!fs.existsSync(this.options.envFilePath)) {
      return {};
    }

    const raw = fs.readFileSync(this.options.envFilePath, "utf8");
    return dotenv.parse(raw);
  }

  private writeEnvMap(envMap: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.options.envFilePath), { recursive: true });

    const ordered = Object.keys(envMap).sort((a, b) => a.localeCompare(b));
    const lines = ["# Managed by AirBridge Web UI"];
    for (const key of ordered) {
      if (!envMap[key]) {
        continue;
      }
      lines.push(`${key}=${formatEnvValue(envMap[key])}`);
    }

    fs.writeFileSync(this.options.envFilePath, `${lines.join("\n")}\n`, "utf8");
  }

  private getServiceState(serviceName: string): ServiceState {
    const active = spawnSync("systemctl", ["is-active", serviceName], { encoding: "utf8" });
    const enabled = spawnSync("systemctl", ["is-enabled", serviceName], { encoding: "utf8" });

    const activeStdout = typeof active.stdout === "string" ? active.stdout.trim() : "";
    const activeStderr = typeof active.stderr === "string" ? active.stderr.trim() : "";
    const enabledStdout = typeof enabled.stdout === "string" ? enabled.stdout.trim() : "";
    const enabledStderr = typeof enabled.stderr === "string" ? enabled.stderr.trim() : "";

    const activeValue = active.status === 0 ? "active" : activeStdout || activeStderr;
    const enabledValue = enabled.status === 0 ? "enabled" : enabledStdout || enabledStderr;

    return {
      active:
        activeValue === "active" || activeValue === "inactive" || activeValue === "failed"
          ? activeValue
          : "unknown",
      enabled: enabledValue === "enabled" || enabledValue === "disabled" ? enabledValue : "unknown",
    };
  }
}
