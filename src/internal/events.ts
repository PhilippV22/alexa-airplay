import { Router } from "express";

interface InternalEventsRouterOptions {
  onPlayStart: (targetId: number) => Promise<void>;
  onPlayStop: (targetId: number) => void;
}

function isLoopback(ipAddress: string | undefined): boolean {
  if (!ipAddress) {
    return false;
  }
  return (
    ipAddress === "127.0.0.1" ||
    ipAddress === "::1" ||
    ipAddress === "::ffff:127.0.0.1" ||
    ipAddress.startsWith("127.")
  );
}

export function createInternalEventsRouter(options: InternalEventsRouterOptions): Router {
  const router = Router();

  router.post("/internal/events/play-start/:targetId", async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!isLoopback(ip)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }

    const targetId = Number.parseInt(req.params.targetId, 10);
    if (Number.isNaN(targetId)) {
      res.status(400).json({ error: "BAD_TARGET_ID" });
      return;
    }

    try {
      await options.onPlayStart(targetId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        error: "PLAY_START_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/internal/events/play-stop/:targetId", (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!isLoopback(ip)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }

    const targetId = Number.parseInt(req.params.targetId, 10);
    if (Number.isNaN(targetId)) {
      res.status(400).json({ error: "BAD_TARGET_ID" });
      return;
    }

    options.onPlayStop(targetId);
    res.json({ ok: true });
  });

  return router;
}
