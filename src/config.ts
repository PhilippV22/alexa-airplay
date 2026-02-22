import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

const dataRoot = ensureDir(path.resolve(process.env.AIRBRIDGE_DATA_ROOT ?? "./var"));
const dbDir = ensureDir(path.join(dataRoot, "db"));
const runRoot = ensureDir(path.resolve(process.env.AIRBRIDGE_RUN_ROOT ?? "./run"));
const hlsRoot = ensureDir(path.resolve(process.env.AIRBRIDGE_HLS_ROOT ?? path.join(dataRoot, "hls")));
const shairportConfigRoot = ensureDir(path.join(runRoot, "shairport"));

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  bindHost: process.env.AIRBRIDGE_BIND_HOST ?? "0.0.0.0",
  port: envInt("AIRBRIDGE_PORT", 3000),
  dbPath: path.resolve(process.env.AIRBRIDGE_DB_PATH ?? path.join(dbDir, "airbridge.sqlite")),
  dataRoot,
  runRoot,
  fifoRoot: ensureDir(path.resolve(process.env.AIRBRIDGE_FIFO_ROOT ?? path.join(runRoot, "fifo"))),
  hlsRoot,
  shairportConfigRoot,
  shairportBin: process.env.AIRBRIDGE_SHAIRPORT_BIN ?? "shairport-sync",
  ffmpegBin: process.env.AIRBRIDGE_FFMPEG_BIN ?? "ffmpeg",
  ffmpegBitrate: process.env.AIRBRIDGE_FFMPEG_BITRATE ?? "192k",
  streamBaseUrl: env("AIRBRIDGE_STREAM_BASE_URL", "https://stream.example.com"),
  adminUser: process.env.AIRBRIDGE_ADMIN_USER ?? "admin",
  adminPasswordHash: process.env.AIRBRIDGE_ADMIN_PASSWORD_HASH,
  adminPasswordPlain: process.env.AIRBRIDGE_ADMIN_PASSWORD,
  sessionSecret: env("AIRBRIDGE_SESSION_SECRET", "change-this-secret"),
  sessionTtlSeconds: envInt("AIRBRIDGE_SESSION_TTL_SECONDS", 60 * 60 * 8),
  apiRateLimitPerMinute: envInt("AIRBRIDGE_AUTH_RATE_LIMIT", 12),
  allowedLanCidrs: (process.env.AIRBRIDGE_ALLOWED_LAN_CIDRS ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  alexaCookiePath: process.env.AIRBRIDGE_ALEXA_COOKIE_PATH,
  alexaInvokeMode: process.env.AIRBRIDGE_ALEXA_INVOKE_MODE ?? "mock",
  alexaInvocationPrefix: process.env.AIRBRIDGE_ALEXA_INVOCATION_PREFIX ?? "ask air bridge to play token",
  alexaSkillInvocationName: process.env.AIRBRIDGE_ALEXA_SKILL_INVOCATION_NAME ?? "air bridge",
  alexaInvocationPrefixFallbacks: process.env.AIRBRIDGE_ALEXA_INVOCATION_PREFIX_FALLBACKS ?? "",
  alexaSkillInvokeTimeoutSeconds: envInt("AIRBRIDGE_ALEXA_SKILL_INVOKE_TIMEOUT_SECONDS", 6),
  alexaSkillInvokeRetryCount: envInt("AIRBRIDGE_ALEXA_SKILL_INVOKE_RETRY_COUNT", 2),
  skillAppId: process.env.AIRBRIDGE_SKILL_APP_ID,
  alexaInitTimeoutSeconds: envInt("AIRBRIDGE_ALEXA_INIT_TIMEOUT_SECONDS", 60),
  spawnProcesses: envBool("AIRBRIDGE_SPAWN_PROCESSES", true),
  hlsSegmentSeconds: envInt("AIRBRIDGE_HLS_SEGMENT_SECONDS", 2),
  hlsListSize: envInt("AIRBRIDGE_HLS_LIST_SIZE", 6),
  monitorIntervalMs: envInt("AIRBRIDGE_MONITOR_INTERVAL_MS", 2000),
  skipAuthForLocalhost: envBool("AIRBRIDGE_SKIP_AUTH_FOR_LOCALHOST", false),
  trustProxy: envBool("AIRBRIDGE_TRUST_PROXY", false),
  setupEnvFilePath: path.resolve(
    process.env.AIRBRIDGE_SETUP_ENV_FILE ?? "/etc/airbridge/airbridge.env",
  ),
  setupCloudflaredFilePath: path.resolve(
    process.env.AIRBRIDGE_SETUP_CLOUDFLARED_FILE ?? "/etc/airbridge/cloudflared.yml",
  ),
  setupPlainAlexaCookieFilePath: path.resolve(
    process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_FILE ?? "/etc/airbridge/alexa-cookie.txt",
  ),
  setupEncryptedAlexaCookieFilePath: path.resolve(
    process.env.AIRBRIDGE_SETUP_ALEXA_COOKIE_ENCRYPTED_FILE ??
      "/etc/credstore.encrypted/airbridge_alexa_cookie",
  ),
  serviceName: process.env.AIRBRIDGE_SERVICE_NAME ?? "airbridge.service",
  cloudflaredServiceName:
    process.env.AIRBRIDGE_CLOUDFLARED_SERVICE_NAME ?? "cloudflared-airbridge.service",
  setupAllowCredentialEncryption: envBool("AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION", false),
  alexaCookieWizardProxyPort: envInt("AIRBRIDGE_ALEXA_COOKIE_WIZARD_PROXY_PORT", 3457),
  alexaCookieWizardTimeoutSeconds: envInt("AIRBRIDGE_ALEXA_COOKIE_WIZARD_TIMEOUT_SECONDS", 600),
  alexaCookieWizardMock: envBool("AIRBRIDGE_ALEXA_COOKIE_WIZARD_MOCK", false),
};

if (!config.adminPasswordHash && !config.adminPasswordPlain) {
  throw new Error("Set AIRBRIDGE_ADMIN_PASSWORD_HASH or AIRBRIDGE_ADMIN_PASSWORD");
}
