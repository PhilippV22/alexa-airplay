import { randomBytes } from "node:crypto";
import { AppError } from "./errors";
import { logger } from "./logger";
import { MetricsService } from "./metrics";
import { Store } from "./store";
import { ErrorCode, Session, Target } from "./types";
import { AlexaAdapter } from "./alexa/adapter";

export class PlaybackService {
  private readonly store: Store;
  private readonly adapter: AlexaAdapter;
  private readonly streamBaseUrl: string;
  private readonly metrics: MetricsService;

  private static normalizeToken(token: string): string {
    return token.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  constructor(store: Store, adapter: AlexaAdapter, streamBaseUrl: string, metrics: MetricsService) {
    this.store = store;
    this.adapter = adapter;
    this.streamBaseUrl = streamBaseUrl;
    this.metrics = metrics;
  }

  async startForTarget(targetId: number, actor: string): Promise<Session> {
    const target = this.store.getTarget(targetId);
    if (!target) {
      throw new AppError(404, "NOT_FOUND", "Target not found", { targetId });
    }

    if (target.type === "group") {
      this.store.addAudit(actor, "target.start", target.id, "failure", {
        reason: "GROUP_NATIVE_UNSUPPORTED",
      });
      throw new AppError(
        409,
        "GROUP_NATIVE_UNSUPPORTED",
        "Native Alexa group streaming is not supported in consumer mode",
      );
    }

    if (!target.enabled || target.status !== "active") {
      throw new AppError(409, "BAD_REQUEST", "Target is not active", {
        status: target.status,
        enabled: target.enabled,
      });
    }

    const existingSession = this.store.getActiveSessionByTarget(targetId);
    if (existingSession) {
      return existingSession;
    }

    const token = randomBytes(12).toString("hex");
    const streamUrl = this.buildSessionUrl(token);
    const session = this.store.createSession(target.id, streamUrl, token, "buffering");

    try {
      await this.adapter.invokeStream(target, token, streamUrl);
      this.store.updateSessionState(session.id, "playing", null);
      this.store.addAudit(actor, "alexa.invoke", target.id, "success", {
        sessionId: session.id,
        streamUrl,
      });
      this.metrics.setActiveSessions(this.store.countActiveSessions());
      return this.store.getSession(session.id) ?? session;
    } catch (error) {
      const mappedCode = this.mapErrorCode(error);
      this.store.finishSessionByToken(token, "error", mappedCode);
      this.store.addAudit(actor, "alexa.invoke", target.id, "failure", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
        code: mappedCode,
      });
      this.metrics.setActiveSessions(this.store.countActiveSessions());
      throw new AppError(502, mappedCode, "Alexa invocation failed", {
        sessionId: session.id,
      });
    }
  }

  stopForTarget(targetId: number, actor: string): void {
    const target = this.store.getTarget(targetId);
    if (!target) {
      return;
    }

    this.store.finishActiveSessionByTarget(targetId, "stopped", null);
    this.store.addAudit(actor, "session.stop", target.id, "success", {
      reason: "audio_inactive",
    });
    this.metrics.setActiveSessions(this.store.countActiveSessions());
  }

  markTargetError(targetId: number, errorCode: ErrorCode, actor: string, details?: string): void {
    this.store.finishActiveSessionByTarget(targetId, "error", errorCode);
    this.store.addAudit(actor, "target.error", targetId, "failure", {
      errorCode,
      details,
    });
    const target = this.store.getTarget(targetId);
    if (target) {
      this.store.updateTarget(targetId, { status: "error" });
    }
    this.metrics.setActiveSessions(this.store.countActiveSessions());
  }

  resolveSessionToken(token: string): { session: Session; target: Target } | null {
    const session = this.store.getSessionByToken(token);
    if (!session) {
      // Alexa NLU can strip separators from token slot values.
      const requested = PlaybackService.normalizeToken(token);
      if (!requested) {
        return this.resolveSingleActiveSession();
      }

      const active = this.store.listActiveSessions();
      let matched: Session | null = null;
      for (const candidate of active) {
        if (PlaybackService.normalizeToken(candidate.stream_token) !== requested) {
          continue;
        }
        if (matched) {
          return null;
        }
        matched = candidate;
      }

      if (!matched) {
        return this.resolveSingleActiveSession();
      }

      const target = this.store.getTarget(matched.target_id);
      if (!target) {
        return null;
      }

      return { session: matched, target };
    }

    const target = this.store.getTarget(session.target_id);
    if (!target) {
      return null;
    }

    return { session, target };
  }

  private resolveSingleActiveSession(): { session: Session; target: Target } | null {
    const active = this.store.listActiveSessions();
    if (active.length !== 1) {
      return null;
    }

    const session = active[0];
    const target = this.store.getTarget(session.target_id);
    if (!target) {
      return null;
    }

    return { session, target };
  }

  private buildSessionUrl(token: string): string {
    const normalizedBase = this.streamBaseUrl.endsWith("/")
      ? this.streamBaseUrl.slice(0, -1)
      : this.streamBaseUrl;
    return `${normalizedBase}/hls/${token}/index.m3u8`;
  }

  private mapErrorCode(error: unknown): ErrorCode {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code: string }).code;
      if (
        code === "ALEXA_AUTH_FAILED" ||
        code === "ALEXA_INVOKE_FAILED" ||
        code === "TUNNEL_UNAVAILABLE" ||
        code === "TRANSCODER_FAILED" ||
        code === "GROUP_NATIVE_UNSUPPORTED"
      ) {
        return code;
      }
    }

    logger.error("unexpected playback error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "ALEXA_INVOKE_FAILED";
  }
}
