export type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel = (process.env.AIRBRIDGE_LOG_LEVEL as LogLevel | undefined) ?? "info";

function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (levels[level] < levels[minLevel]) {
    return;
  }
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => write("debug", message, data),
  info: (message: string, data?: Record<string, unknown>) => write("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) => write("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) => write("error", message, data),
};
