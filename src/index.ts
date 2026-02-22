import { createServer } from "node:http";
import { config } from "./config";
import { logger } from "./logger";
import { createApp } from "./server";

async function main(): Promise<void> {
  const { app, reconcileTargets, processManager, store } = await createApp();

  const server = createServer(app);

  server.listen(config.port, config.bindHost, async () => {
    logger.info("airbridge server listening", {
      host: config.bindHost,
      port: config.port,
      env: config.nodeEnv,
    });

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
