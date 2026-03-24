import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { nanoid } from "nanoid";
import { config } from "./config";
import { AuthService } from "./auth";
import { logger } from "./logger";
import { MetricsService } from "./metrics";
import { Store } from "./store";
import { AppError } from "./errors";
import { ProcessManager } from "./process/manager";
import { Target } from "./types";
import { SetupService } from "./setup";
import { loginPageHtml, mainPageHtml } from "./ui/pages";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createTargetSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["bluetooth"]),
  bluetooth_mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/).optional(),
  airplay_name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const updateTargetSchema = z.object({
  name: z.string().min(1).optional(),
  bluetooth_mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/).nullable().optional(),
  airplay_name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["active", "error", "disabled"]).optional(),
});

const setupConfigSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const setupAdminPasswordSchema = z.object({
  password: z.string().min(8),
});

const setupApplySchema = z.object({
  restart: z.boolean().optional(),
});

interface AppBundle {
  app: express.Express;
  store: Store;
  reconcileTargets: (actor: string) => Promise<void>;
  processManager: ProcessManager;
}

function safeActor(req: Request): string {
  return req.user?.username ?? "anonymous";
}

export async function createApp(): Promise<AppBundle> {
  const store = new Store(config.dbPath);
  const metrics = new MetricsService();

  const auth = await AuthService.create({
    adminUser: config.adminUser,
    passwordHash: config.adminPasswordHash,
    passwordPlain: config.adminPasswordPlain,
    sessionTtlSeconds: config.sessionTtlSeconds,
  });

  const setupService = new SetupService({
    envFilePath: config.setupEnvFilePath,
    serviceName: config.serviceName,
  });

  const processManager = new ProcessManager({
    shairportBin: config.shairportBin,
    ffmpegBin: config.ffmpegBin,
    fifoRoot: config.fifoRoot,
    shairportConfigRoot: config.shairportConfigRoot,
    monitorIntervalMs: config.monitorIntervalMs,
    spawnProcesses: config.spawnProcesses,
    onAudioStart: (target: Target) => {
      logger.info("audio started", { targetId: target.id, name: target.name });
    },
    onAudioStop: (target: Target) => {
      logger.info("audio stopped", { targetId: target.id, name: target.name });
    },
    onTargetError: (target: Target, code, details) => {
      logger.error("target error", { targetId: target.id, code, details });
      store.updateTarget(target.id, { status: "error" });
    },
  });

  const reconcileTargets = async (actor: string): Promise<void> => {
    const targets = store.listTargets();
    const enabledTargets = targets.filter(
      (target) => target.enabled === 1 && target.status === "active",
    );

    try {
      await processManager.reconcile(targets);
      metrics.incReconcile("success");
      metrics.setActiveTargets(enabledTargets.length);
      metrics.setActiveProcesses(processManager.getActiveProcessCount());
      store.addAudit(actor, "targets.reconcile", null, "success", {
        totalTargets: targets.length,
        activeTargets: enabledTargets.length,
      });
    } catch (error) {
      metrics.incReconcile("failure");
      store.addAudit(actor, "targets.reconcile", null, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const app = express();
  app.set("trust proxy", config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser(config.sessionSecret));
  app.use((req, _res, next) => {
    req.requestId = nanoid(12);
    next();
  });
  app.use(metrics.httpMiddleware);

  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: config.apiRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get("/login", (_req, res) => {
    res.type("html").send(loginPageHtml());
  });

  app.get("/", (req, res) => {
    const token = req.signedCookies?.airbridge_session as string | undefined;
    const session = auth.validateSession(token);
    if (!session) {
      res.redirect("/login");
      return;
    }
    res.type("html").send(mainPageHtml(config.adminUser));
  });

  app.post("/api/auth/login", authLimiter, async (req, res, next) => {
    try {
      const parsed = loginSchema.parse(req.body);
      const token = await auth.login(parsed.username, parsed.password);
      if (!token) {
        store.addAudit(parsed.username, "auth.login", null, "failure", {
          ip: req.ip,
          reason: "invalid_credentials",
        });
        res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid credentials" });
        return;
      }

      const cookieOptions = auth.getSessionCookieOptions(
        config.nodeEnv === "production",
        config.sessionTtlSeconds * 1000,
      );
      res.cookie("airbridge_session", token, cookieOptions);
      store.addAudit(parsed.username, "auth.login", null, "success", { ip: req.ip });
      res.json({ ok: true, username: parsed.username });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", auth.requireAuth, (req, res) => {
    const token = req.user?.token;
    if (token) {
      auth.logout(token);
    }
    res.clearCookie("airbridge_session");
    store.addAudit(safeActor(req), "auth.logout", null, "success", {
      ip: req.ip,
    });
    res.json({ ok: true });
  });

  app.get("/api/auth/me", auth.requireAuth, (req, res) => {
    res.json({ username: req.user?.username ?? "" });
  });

  const api = express.Router();
  api.use(auth.requireAuth);

  api.get("/setup/status", (req, res) => {
    const status = setupService.getStatus({
      hasAdminPasswordHash: Boolean(config.adminPasswordHash),
      hasSessionSecret: Boolean(config.sessionSecret && config.sessionSecret !== "change-this-secret"),
    });
    res.json({ status });
  });

  api.get("/setup/config", (_req, res) => {
    const setupConfig = setupService.getConfig(process.env);
    res.json(setupConfig);
  });

  api.put("/setup/config", (req, res, next) => {
    try {
      const body = setupConfigSchema.parse(req.body);
      const updated = setupService.updateConfig(body.values);
      store.addAudit(safeActor(req), "setup.config.update", null, "success", {
        updatedKeys: Object.keys(body.values),
      });
      res.json({
        ok: true,
        ...updated,
      });
    } catch (error) {
      store.addAudit(safeActor(req), "setup.config.update", null, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  api.post("/setup/admin-password", async (req, res, next) => {
    try {
      const body = setupAdminPasswordSchema.parse(req.body);
      await setupService.setAdminPassword(body.password);
      store.addAudit(safeActor(req), "setup.admin_password.update", null, "success", {});
      res.json({
        ok: true,
        message: "Admin password updated. Restart the service to apply it.",
      });
    } catch (error) {
      store.addAudit(safeActor(req), "setup.admin_password.update", null, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  api.post("/setup/apply", (req, res, next) => {
    try {
      const body = setupApplySchema.parse(req.body);
      if (body.restart) {
        setupService.scheduleSelfRestart();
      }
      store.addAudit(safeActor(req), "setup.apply", null, "success", {
        restartScheduled: Boolean(body.restart),
      });
      res.json({
        ok: true,
        restartScheduled: Boolean(body.restart),
      });
    } catch (error) {
      store.addAudit(safeActor(req), "setup.apply", null, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  api.get("/targets", (_req, res) => {
    const targets = store.listTargets();
    const processInfo = processManager.getProcessInfos();
    res.json({ targets, processInfo });
  });

  api.post("/targets", async (req, res, next) => {
    try {
      const body = createTargetSchema.parse(req.body);

      const created = store.createTarget(body);
      store.addAudit(safeActor(req), "target.create", created.id, "success", {
        type: created.type,
        enabled: created.enabled,
      });

      if (created.enabled === 1) {
        await reconcileTargets(safeActor(req));
      }

      res.status(201).json({ target: created });
    } catch (error) {
      next(error);
    }
  });

  api.patch("/targets/:id", async (req, res, next) => {
    try {
      const targetId = Number.parseInt(req.params.id, 10);
      if (Number.isNaN(targetId)) {
        throw new AppError(400, "BAD_REQUEST", "Invalid target id");
      }

      const current = store.getTarget(targetId);
      if (!current) {
        throw new AppError(404, "NOT_FOUND", "Target not found");
      }

      const patch = updateTargetSchema.parse(req.body);
      const normalizedPatch = { ...patch };

      if (patch.enabled === false && patch.status === undefined) {
        normalizedPatch.status = "disabled";
      }

      if (patch.enabled === true && patch.status === undefined) {
        normalizedPatch.status = "active";
      }

      const updated = store.updateTarget(targetId, normalizedPatch);
      if (!updated) {
        throw new AppError(404, "NOT_FOUND", "Target not found");
      }

      store.addAudit(safeActor(req), "target.update", updated.id, "success", {
        patch: normalizedPatch,
      });

      await reconcileTargets(safeActor(req));

      res.json({ target: updated });
    } catch (error) {
      next(error);
    }
  });

  api.delete("/targets/:id", async (req, res, next) => {
    try {
      const targetId = Number.parseInt(req.params.id, 10);
      if (Number.isNaN(targetId)) {
        throw new AppError(400, "BAD_REQUEST", "Invalid target id");
      }

      const target = store.getTarget(targetId);
      if (!target) {
        throw new AppError(404, "NOT_FOUND", "Target not found");
      }

      const deleted = store.deleteTarget(targetId);
      if (!deleted) {
        throw new AppError(404, "NOT_FOUND", "Target not found");
      }

      store.addAudit(safeActor(req), "target.delete", null, "success", {
        targetId,
        name: target.name,
      });

      await reconcileTargets(safeActor(req));

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  api.post("/targets/:id/reconcile", async (req, res, next) => {
    try {
      const targetId = Number.parseInt(req.params.id, 10);
      if (Number.isNaN(targetId)) {
        throw new AppError(400, "BAD_REQUEST", "Invalid target id");
      }

      const target = store.getTarget(targetId);
      if (!target) {
        throw new AppError(404, "NOT_FOUND", "Target not found");
      }

      if (target.enabled === 1 && target.status !== "active") {
        store.updateTarget(target.id, { status: "active" });
      }

      await reconcileTargets(safeActor(req));

      store.addAudit(safeActor(req), "target.reconcile", target.id, "success", {
        status: "reconciled",
      });

      const fresh = store.getTarget(target.id);
      res.json({ target: fresh });
    } catch (error) {
      next(error);
    }
  });

  api.get("/audit", (_req, res) => {
    res.json({ audit: store.listAudit() });
  });

  // Bluetooth API
  api.get("/bt/devices", (_req, res) => {
    try {
      const result = spawnSync("bluetoothctl", ["devices"], { encoding: "utf8", timeout: 5000 });
      const lines = (result.stdout || "").split("\n").filter((l) => l.startsWith("Device "));
      const devices = lines.map((line) => {
        const parts = line.split(" ");
        return { mac: parts[1], name: parts.slice(2).join(" ") || parts[1] };
      });
      res.json({ devices });
    } catch {
      res.json({ devices: [] });
    }
  });

  api.post("/bt/scan", (_req, res) => {
    spawnSync("bluetoothctl", ["power", "on"], { timeout: 5000 });
    spawnSync("bluetoothctl", ["--timeout", "8", "scan", "on"], { timeout: 12000 });
    try {
      const result = spawnSync("bluetoothctl", ["devices"], { encoding: "utf8", timeout: 5000 });
      const lines = (result.stdout || "").split("\n").filter((l) => l.startsWith("Device "));
      const devices = lines.map((line) => {
        const parts = line.split(" ");
        return { mac: parts[1], name: parts.slice(2).join(" ") || parts[1] };
      });
      res.json({ devices });
    } catch {
      res.json({ devices: [] });
    }
  });

  api.post("/bt/pair", (req, res) => {
    const { mac } = z.object({ mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/) }).parse(req.body);
    execFile("bluetoothctl", ["pair", mac], { timeout: 30000 }, (err1) => {
      execFile("bluetoothctl", ["trust", mac], { timeout: 5000 }, (err2) => {
        if (err1 && err2) {
          res.status(500).json({ error: "BT_PAIR_FAILED", message: err1.message });
          return;
        }
        store.addAudit(safeActor(req), "bt.pair", null, "success", { mac });
        res.json({ ok: true, mac });
      });
    });
  });

  api.delete("/bt/unpair/:mac", (req, res) => {
    const mac = req.params.mac;
    execFile("bluetoothctl", ["remove", mac], { timeout: 5000 }, (err) => {
      if (err) {
        res.status(500).json({ error: "BT_REMOVE_FAILED", message: err.message });
        return;
      }
      store.addAudit(safeActor(req), "bt.unpair", null, "success", { mac });
      res.json({ ok: true });
    });
  });

  app.use("/api", api);

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  app.get("/health/ready", (_req, res) => {
    res.json({
      status: "ready",
      db: "ok",
      processManager: "ok",
    });
  });

  app.get("/health/setup", (_req, res) => {
    const checkBin = (bin: string): boolean => {
      if (path.isAbsolute(bin)) return fs.existsSync(bin);
      return true;
    };

    const activeTargets = store.listEnabledTargets();

    res.json({
      shairportBin: { ok: checkBin(config.shairportBin), path: config.shairportBin },
      ffmpegBin: { ok: checkBin(config.ffmpegBin), path: config.ffmpegBin },
      activeTargets: { ok: activeTargets.length > 0, count: activeTargets.length },
    });
  });

  app.get("/metrics", async (_req, res, next) => {
    try {
      res.set("Content-Type", metrics.registry.contentType);
      res.send(await metrics.metricsText());
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND", path: req.path });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: "BAD_REQUEST",
        message: "Invalid request body",
        issues: err.issues,
      });
      return;
    }

    if (err instanceof AppError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        details: err.details,
      });
      return;
    }

    logger.error("unhandled error", {
      requestId: req.requestId,
      error: err instanceof Error ? err.message : String(err),
      path: req.path,
    });

    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Unexpected server error",
    });
  });

  return {
    app,
    store,
    reconcileTargets,
    processManager,
  };
}
