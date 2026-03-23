import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { logger } from "./logger";
import { createApp } from "./server";

function warnMisconfig(): void {
  if (config.streamBaseUrl.includes("example.com")) {
    logger.warn(
      "AIRBRIDGE_STREAM_BASE_URL enthaelt noch Platzhalter – Playback wird nicht funktionieren. " +
        "Stream-URL in Web-UI unter System Setup setzen.",
    );
  }
  if (config.spawnProcesses) {
    if (config.shairportBin && path.isAbsolute(config.shairportBin)) {
      try {
        fs.accessSync(config.shairportBin, fs.constants.X_OK);
      } catch {
        logger.warn(`shairport-sync nicht gefunden oder nicht ausfuehrbar: ${config.shairportBin}`);
      }
    }
    if (config.ffmpegBin && path.isAbsolute(config.ffmpegBin)) {
      try {
        fs.accessSync(config.ffmpegBin, fs.constants.X_OK);
      } catch {
        logger.warn(`ffmpeg nicht gefunden oder nicht ausfuehrbar: ${config.ffmpegBin}`);
      }
    }
  }
  if (config.alexaInvokeMode === "alexa_remote2" && config.alexaCookiePath) {
    try {
      const stat = fs.statSync(config.alexaCookiePath);
      if (stat.size === 0) {
        logger.warn(
          "Alexa-Cookie-Datei ist leer – Cookie Wizard in Web-UI starten (System Setup).",
        );
      }
    } catch {
      logger.warn(
        `Alexa-Cookie-Datei fehlt: ${config.alexaCookiePath} – Cookie Wizard in Web-UI starten.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { app, reconcileTargets, processManager, store } = await createApp();

  const server = createServer(app);

  server.listen(config.port, config.bindHost, async () => {
    logger.info("airbridge server listening", {
      host: config.bindHost,
      port: config.port,
      env: config.nodeEnv,
    });

    warnMisconfig();

    try {
      await reconcileTargets("system");
    } catch (error) {
      logger.error("initial reconcile failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const reconcileTicker = setInterval(() => {
    void reconcileTargets("system").catch((error) => {
      logger.error("periodic reconcile failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 30_000);
  reconcileTicker.unref();

  const shutdown = (): void => {
    logger.info("shutdown requested");
    clearInterval(reconcileTicker);
    processManager.stopAll();
    store.close();
    server.close((error) => {
      if (error) {
        logger.error("failed to close server", {
          error: error.message,
        });
        process.exitCode = 1;
      }
      process.exit();
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  logger.error("fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
