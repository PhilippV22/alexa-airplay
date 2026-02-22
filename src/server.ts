import fs from "node:fs";
import path from "node:path";
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
import { PlaybackService } from "./playback";
import { AlexaAdapter } from "./alexa/adapter";
import { AlexaCookieWizardService } from "./alexa/cookieWizard";
import { createSkillRouter } from "./alexa/skill";
import { createInternalEventsRouter } from "./internal/events";
import { Target } from "./types";
import { SetupService } from "./setup";
import { loginPageHtml, mainPageHtml } from "./ui/pages";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createTargetSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["device", "group"]),
  alexa_device_id: z.string().optional(),
  alexa_group_id: z.string().optional(),
  airplay_name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const updateTargetSchema = z.object({
  name: z.string().min(1).optional(),
  alexa_device_id: z.string().nullable().optional(),
  alexa_group_id: z.string().nullable().optional(),
  airplay_name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["active", "blocked_group_native_unsupported", "error", "disabled"]).optional(),
});

const setupConfigSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const setupAdminPasswordSchema = z.object({
  password: z.string().min(8),
});

const setupAlexaCookieSchema = z.object({
  cookie: z.string().min(1),
  preferEncrypted: z.boolean().optional(),
});

const setupCloudflaredSchema = z.object({
  content: z.string().min(1),
});

const setupApplySchema = z.object({
  restart: z.boolean().optional(),
});

const setupAlexaCookieWizardStartSchema = z.object({
  amazonPage: z.string().min(3).optional(),
  baseAmazonPage: z.string().min(3).optional(),
  acceptLanguage: z.string().min(2).optional(),
  proxyHost: z.string().min(1).optional(),
  proxyPort: z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? value : parsed;
      }
      return value;
    },
    z.number().int().min(1).max(65535).optional(),
  ),
  preferEncrypted: z.boolean().optional(),
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

function sanitizeFile(fileName: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return null;
  }
  return fileName;
}

function inferBaseAmazonPage(amazonPage: string): string {
  if (amazonPage.endsWith("amazon.co.jp")) {
    return "amazon.co.jp";
  }
  return "amazon.com";
}

function inferAcceptLanguage(amazonPage: string): string {
  if (amazonPage.endsWith("amazon.de")) {
    return "de-DE";
  }
  if (amazonPage.endsWith("amazon.co.uk")) {
    return "en-GB";
  }
  if (amazonPage.endsWith("amazon.fr")) {
    return "fr-FR";
  }
  if (amazonPage.endsWith("amazon.it")) {
    return "it-IT";
  }
  if (amazonPage.endsWith("amazon.es")) {
    return "es-ES";
  }
  if (amazonPage.endsWith("amazon.co.jp")) {
    return "ja-JP";
  }
  return "en-US";
}

function inferProxyHost(req: Request): string {
  const forwardedHost = req.headers["x-forwarded-host"];
  if (typeof forwardedHost === "string" && forwardedHost.trim()) {
    return forwardedHost.split(",")[0].trim().split(":")[0];
  }

  const hostHeader = req.headers.host;
  if (hostHeader) {
    return hostHeader.split(":")[0];
  }

  if (req.hostname) {
    return req.hostname;
  }

  return "127.0.0.1";
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

  const alexaAdapter = new AlexaAdapter({
    mode: config.alexaInvokeMode,
    cookiePath: config.alexaCookiePath,
    invocationPrefix: process.env.AIRBRIDGE_ALEXA_INVOCATION_PREFIX,
    initTimeoutMs: config.alexaInitTimeoutSeconds * 1000,
  });

  try {
    await alexaAdapter.init();
  } catch (error) {
    logger.error("alexa adapter init failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const playback = new PlaybackService(store, alexaAdapter, config.streamBaseUrl, metrics);
  const setupService = new SetupService({
    envFilePath: config.setupEnvFilePath,
    cloudflaredConfigPath: config.setupCloudflaredFilePath,
    plainAlexaCookiePath: config.setupPlainAlexaCookieFilePath,
    encryptedAlexaCookiePath: config.setupEncryptedAlexaCookieFilePath,
    serviceName: config.serviceName,
    cloudflaredServiceName: config.cloudflaredServiceName,
    allowCredentialEncryption: config.setupAllowCredentialEncryption,
  });
  const alexaCookieWizard = new AlexaCookieWizardService(setupService, {
    timeoutMs: config.alexaCookieWizardTimeoutSeconds * 1000,
    mockMode: config.alexaCookieWizardMock,
  });

  const processManager = new ProcessManager({
    shairportBin: config.shairportBin,
    ffmpegBin: config.ffmpegBin,
    fifoRoot: config.fifoRoot,
    hlsRoot: config.hlsRoot,
    shairportConfigRoot: config.shairportConfigRoot,
    ffmpegBitrate: config.ffmpegBitrate,
    hlsSegmentSeconds: config.hlsSegmentSeconds,
    hlsListSize: config.hlsListSize,
    monitorIntervalMs: config.monitorIntervalMs,
    spawnProcesses: config.spawnProcesses,
    onAudioStart: (target) => {
      void playback.startForTarget(target.id, "system").catch((error) => {
        logger.error("playback start from monitor failed", {
          targetId: target.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onAudioStop: (target) => {
      playback.stopForTarget(target.id, "system");
    },
    onTargetError: (target, code, details) => {
      playback.markTargetError(target.id, code, "system", details);
    },
  });

  const reconcileTargets = async (actor: string): Promise<void> => {
    const targets = store.listTargets();
    const enabledDevices = targets.filter(
      (target) => target.type === "device" && target.enabled === 1 && target.status === "active",
    );

    try {
      await processManager.reconcile(targets);
      metrics.incReconcile("success");
      metrics.setActiveTargets(enabledDevices.length);
      metrics.setActiveProcesses(processManager.getActiveProcessCount());
      metrics.setActiveSessions(store.countActiveSessions());
      store.addAudit(actor, "targets.reconcile", null, "success", {
        totalTargets: targets.length,
        activeDevices: enabledDevices.length,
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

  app.use(
    createInternalEventsRouter({
      onPlayStart: async (targetId) => {
        await playback.startForTarget(targetId, "system");
      },
      onPlayStop: (targetId) => {
        playback.stopForTarget(targetId, "system");
      },
    }),
  );

  app.use(
    createSkillRouter({
      appId: process.env.AIRBRIDGE_SKILL_APP_ID,
      resolveToken: (token) => playback.resolveSessionToken(token),
      onSkillInvoke: (targetId, token, result, reason) => {
        store.addAudit("skill", "skill.invoke", targetId > 0 ? targetId : null, result, {
          token,
          reason,
        });
      },
    }),
  );

  app.get("/hls/:token/:file", (req, res) => {
    const token = req.params.token;
    const file = sanitizeFile(req.params.file);
    if (!file) {
      res.status(400).json({ error: "BAD_REQUEST" });
      return;
    }

    const resolved = playback.resolveSessionToken(token);
    if (!resolved) {
      res.status(404).json({ error: "SESSION_NOT_FOUND" });
      return;
    }

    const baseDir = path.resolve(path.join(config.hlsRoot, String(resolved.target.id)));
    const absolutePath = path.resolve(path.join(baseDir, file));
    if (!absolutePath.startsWith(baseDir)) {
      res.status(400).json({ error: "BAD_REQUEST" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (file.endsWith(".m3u8")) {
      res.type("application/vnd.apple.mpegurl");
    } else if (file.endsWith(".ts")) {
      res.type("video/mp2t");
    } else if (file.endsWith(".aac")) {
      res.type("audio/aac");
    }

    res.sendFile(absolutePath);
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

  api.post("/setup/alexa-cookie", (req, res, next) => {
    try {
      const body = setupAlexaCookieSchema.parse(req.body);
      const result = setupService.setAlexaCookie(body.cookie, body.preferEncrypted ?? true);
      store.addAudit(safeActor(req), "setup.alexa_cookie.update", null, "success", {
        mode: result.mode,
        path: result.path,
      });
      res.json({
        ok: true,
        result,
        message: "Alexa cookie stored. Restart the service to apply it.",
      });
    } catch (error) {
      store.addAudit(safeActor(req), "setup.alexa_cookie.update", null, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  api.post("/setup/alexa-cookie/wizard/start", async (req, res, next) => {
    try {
      const body = setupAlexaCookieWizardStartSchema.parse(req.body);
      const amazonPage = (body.amazonPage ?? "amazon.de").trim();
      const baseAmazonPage = (body.baseAmazonPage ?? inferBaseAmazonPage(amazonPage)).trim();
      const acceptLanguage = (body.acceptLanguage ?? inferAcceptLanguage(amazonPage)).trim();
      const proxyHost = (body.proxyHost ?? inferProxyHost(req)).trim();
      const proxyPort = body.proxyPort ?? config.alexaCookieWizardProxyPort;
      const preferEncrypted = body.preferEncrypted ?? false;

      const state = await alexaCookieWizard.start({
        amazonPage,
        baseAmazonPage,
        acceptLanguage,
        proxyHost,
        proxyPort,
        preferEncrypted,
      });

      store.addAudit(safeActor(req), "setup.alexa_cookie_wizard.start", null, "success", {
        amazonPage,
        proxyHost,
        proxyPort,
      });

      res.json({ ok: true, state });
    } catch (error) {
      store.addAudit(safeActor(req), "setup.alexa_cookie_wizard.start", null, "failure", {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  api.get("/setup/alexa-cookie/wizard/status", (_req, res) => {
    res.json({
      ok: true,
      state: alexaCookieWizard.getStatus(),
    });
  });

  api.post("/setup/alexa-cookie/wizard/stop", (req, res) => {
    const state = alexaCookieWizard.stop();
    store.addAudit(safeActor(req), "setup.alexa_cookie_wizard.stop", null, "success", {});
    res.json({ ok: true, state });
  });

  api.put("/setup/cloudflared", (req, res, next) => {
    try {
      const body = setupCloudflaredSchema.parse(req.body);
      setupService.setCloudflaredConfig(body.content);
      store.addAudit(safeActor(req), "setup.cloudflared.update", null, "success", {});
      res.json({ ok: true });
    } catch (error) {
      store.addAudit(safeActor(req), "setup.cloudflared.update", null, "failure", {
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
    res.json({
      targets,
      processInfo,
    });
  });

  api.post("/targets", async (req, res, next) => {
    try {
      const body = createTargetSchema.parse(req.body);

      if (body.type === "group" && body.enabled) {
        store.addAudit(safeActor(req), "target.create", null, "failure", {
          name: body.name,
          reason: "GROUP_NATIVE_UNSUPPORTED",
        });
        throw new AppError(
          409,
          "GROUP_NATIVE_UNSUPPORTED",
          "Group targets cannot be activated in consumer mode",
        );
      }

      const created = store.createTarget(body);
      store.addAudit(safeActor(req), "target.create", created.id, "success", {
        type: created.type,
        enabled: created.enabled,
      });

      if (created.type === "device" && created.enabled === 1) {
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

      if (current.type === "group" && patch.enabled === true) {
        store.addAudit(safeActor(req), "target.update", current.id, "failure", {
          reason: "GROUP_NATIVE_UNSUPPORTED",
          patch,
        });
        throw new AppError(
          409,
          "GROUP_NATIVE_UNSUPPORTED",
          "Group targets cannot be activated in consumer mode",
        );
      }

      const normalizedPatch = { ...patch };

      if (current.type === "group") {
        normalizedPatch.status = "blocked_group_native_unsupported";
      }

      if (current.type === "device" && patch.enabled === false && patch.status === undefined) {
        normalizedPatch.status = "disabled";
      }

      if (current.type === "device" && patch.enabled === true && patch.status === undefined) {
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

      store.addAudit(safeActor(req), "target.delete", targetId, "success", {
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

      if (target.type === "group") {
        store.addAudit(safeActor(req), "target.reconcile", target.id, "failure", {
          reason: "GROUP_NATIVE_UNSUPPORTED",
        });
        throw new AppError(
          409,
          "GROUP_NATIVE_UNSUPPORTED",
          "Group targets cannot be activated in consumer mode",
        );
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

  api.get("/sessions", (_req, res) => {
    res.json({ sessions: store.listSessions() });
  });

  api.get("/audit", (_req, res) => {
    res.json({ audit: store.listAudit() });
  });

  app.use("/api", api);

  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  app.get("/health/ready", (_req, res) => {
    const ready = alexaAdapter.isInitialized();
    res.json({
      status: ready || config.alexaInvokeMode === "mock" ? "ready" : "degraded",
      db: "ok",
      processManager: "ok",
      alexaMode: config.alexaInvokeMode,
      alexaAdapterInitialized: ready,
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
