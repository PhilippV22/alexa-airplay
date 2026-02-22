import { randomBytes } from "node:crypto";
import { AppError } from "./errors";
import { logger } from "./logger";
import { MetricsService } from "./metrics";
import { Store } from "./store";
import { ErrorCode, Session, Target } from "./types";
import { AlexaAdapter } from "./alexa/adapter";

interface PlaybackServiceOptions {
  primaryInvocationPrefix?: string;
  skillInvocationName?: string;
  invocationPrefixFallbacks?: string;
  skillInvokeTimeoutMs?: number;
  skillInvokeRetryCount?: number;
}

interface PendingSkillInvoke {
  targetId: number;
  sessionId: number;
  streamToken: string;
  streamUrl: string;
  actor: string;
  prefixes: string[];
  attemptIndex: number;
  timer: NodeJS.Timeout | null;
}

export class PlaybackService {
  private readonly store: Store;
  private readonly adapter: AlexaAdapter;
  private readonly streamBaseUrl: string;
  private readonly metrics: MetricsService;
  private readonly primaryInvocationPrefix: string;
  private readonly skillInvocationName: string;
  private readonly invocationPrefixFallbacks: string;
  private readonly skillInvokeTimeoutMs: number;
  private readonly skillInvokeRetryCount: number;
  private readonly pendingSkillInvokes = new Map<number, PendingSkillInvoke>();

  private static normalizeToken(token: string): string {
    return token.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  constructor(
    store: Store,
    adapter: AlexaAdapter,
    streamBaseUrl: string,
    metrics: MetricsService,
    options: PlaybackServiceOptions = {},
  ) {
    this.store = store;
    this.adapter = adapter;
    this.streamBaseUrl = streamBaseUrl;
    this.metrics = metrics;
    const skillName = options.skillInvocationName?.trim() || "air bridge";
    this.skillInvocationName = skillName;
    this.primaryInvocationPrefix =
      options.primaryInvocationPrefix?.trim() || `ask ${skillName} to play token`;
    this.invocationPrefixFallbacks = options.invocationPrefixFallbacks ?? "";
    this.skillInvokeTimeoutMs = Math.max(1000, Math.floor(options.skillInvokeTimeoutMs ?? 6000));
    this.skillInvokeRetryCount = Math.max(0, Math.floor(options.skillInvokeRetryCount ?? 2));
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

    this.clearPendingByTarget(targetId);

    const token = randomBytes(12).toString("hex");
    const streamUrl = this.buildSessionUrl(token);
    const session = this.store.createSession(target.id, streamUrl, token, "buffering");
    const pending: PendingSkillInvoke = {
      targetId: target.id,
      sessionId: session.id,
      streamToken: token,
      streamUrl,
      actor,
      prefixes: this.buildInvocationPrefixes(),
      attemptIndex: 0,
      timer: null,
    };
    this.pendingSkillInvokes.set(target.id, pending);

    try {
      await this.invokeAttempt(target, pending, true);
      return this.store.getSession(session.id) ?? session;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const mappedCode = this.mapErrorCode(error);
      throw new AppError(502, mappedCode, "Alexa invocation failed", { sessionId: session.id });
    }
  }

  stopForTarget(targetId: number, actor: string): void {
    const target = this.store.getTarget(targetId);
    if (!target) {
      return;
    }

    this.clearPendingByTarget(targetId);
    this.store.finishActiveSessionByTarget(targetId, "stopped", null);
    this.store.addAudit(actor, "session.stop", target.id, "success", {
      reason: "audio_inactive",
    });
    this.metrics.setActiveSessions(this.store.countActiveSessions());
  }

  markTargetError(targetId: number, errorCode: ErrorCode, actor: string, details?: string): void {
    this.clearPendingByTarget(targetId);
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

  confirmSkillInvoke(targetId: number, token: string): void {
    if (targetId <= 0) {
      return;
    }

    const pending = this.pendingSkillInvokes.get(targetId);
    const session = this.resolveSessionForConfirmation(targetId, token, pending?.sessionId ?? null);
    if (!session || session.ended_at) {
      return;
    }

    if (pending) {
      this.clearPending(pending);
    }

    this.store.updateSessionState(session.id, "playing", null);
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

  private buildInvocationPrefixes(): string[] {
    const skillName = this.skillInvocationName.trim() || "air bridge";
    const primary = this.primaryInvocationPrefix.trim();
    const configuredFallbacks = this.invocationPrefixFallbacks
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const builtInFallbacks = [
      `open ${skillName} and play token`,
      `ask ${skillName} to play token`,
      `oeffne ${skillName} und spiele token`,
      `frage ${skillName} spiele token`,
    ];

    const ordered = [primary, ...configuredFallbacks, ...builtInFallbacks].filter(Boolean);
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const prefix of ordered) {
      const normalized = prefix.toLowerCase().replace(/\s+/g, " ").trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      unique.push(prefix);
    }

    if (unique.length === 0) {
      unique.push(`ask ${skillName} to play token`);
    }

    return unique.slice(0, this.skillInvokeRetryCount + 1);
  }

  private resolveSessionForConfirmation(
    targetId: number,
    token: string,
    expectedSessionId: number | null,
  ): Session | null {
    const normalizedToken = token.trim();
    if (normalizedToken) {
      const resolved = this.resolveSessionToken(normalizedToken);
      if (resolved && resolved.target.id === targetId) {
        return resolved.session;
      }
    }

    if (expectedSessionId !== null) {
      const expected = this.store.getSession(expectedSessionId);
      if (expected && expected.target_id === targetId && !expected.ended_at) {
        return expected;
      }
    }

    return this.store.getActiveSessionByTarget(targetId) ?? null;
  }

  private async invokeAttempt(
    target: Target,
    pending: PendingSkillInvoke,
    throwOnFailure: boolean,
  ): Promise<void> {
    const prefix = pending.prefixes[pending.attemptIndex] ?? this.primaryInvocationPrefix;

    try {
      await this.adapter.invokeStream(target, pending.streamToken, pending.streamUrl, {
        invocationPrefix: prefix,
      });
      this.store.addAudit(pending.actor, "alexa.invoke", target.id, "success", {
        sessionId: pending.sessionId,
        streamUrl: pending.streamUrl,
        attempt: pending.attemptIndex + 1,
        invocationPrefix: prefix,
      });
      this.metrics.setActiveSessions(this.store.countActiveSessions());

      const live = this.pendingSkillInvokes.get(target.id);
      if (!live || live.sessionId !== pending.sessionId) {
        return;
      }
      this.schedulePendingTimeout(live);
    } catch (error) {
      const mappedCode = this.mapErrorCode(error);
      this.failPendingInvoke(target.id, pending.sessionId, pending.streamToken, pending.actor, mappedCode, {
        error: error instanceof Error ? error.message : String(error),
        attempt: pending.attemptIndex + 1,
        invocationPrefix: prefix,
      });

      if (throwOnFailure) {
        throw new AppError(502, mappedCode, "Alexa invocation failed", {
          sessionId: pending.sessionId,
        });
      }
    }
  }

  private schedulePendingTimeout(pending: PendingSkillInvoke): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    pending.timer = setTimeout(() => {
      void this.handlePendingTimeout(pending.targetId, pending.sessionId);
    }, this.skillInvokeTimeoutMs);
    pending.timer.unref();
  }

  private async handlePendingTimeout(targetId: number, sessionId: number): Promise<void> {
    const pending = this.pendingSkillInvokes.get(targetId);
    if (!pending || pending.sessionId !== sessionId) {
      return;
    }
    pending.timer = null;

    const session = this.store.getSession(sessionId);
    if (!session || session.ended_at) {
      this.clearPending(pending);
      return;
    }

    if (pending.attemptIndex >= pending.prefixes.length - 1) {
      this.failPendingInvoke(
        targetId,
        sessionId,
        pending.streamToken,
        pending.actor,
        "ALEXA_INVOKE_FAILED",
        {
          reason: "skill_not_invoked",
          attempts: pending.attemptIndex + 1,
        },
      );
      return;
    }

    const target = this.store.getTarget(targetId);
    if (!target || target.type !== "device" || !target.enabled || target.status !== "active") {
      this.failPendingInvoke(
        targetId,
        sessionId,
        pending.streamToken,
        pending.actor,
        "ALEXA_INVOKE_FAILED",
        {
          reason: "target_not_active",
        },
      );
      return;
    }

    pending.attemptIndex += 1;
    await this.invokeAttempt(target, pending, false);
  }

  private failPendingInvoke(
    targetId: number,
    sessionId: number,
    streamToken: string,
    actor: string,
    code: ErrorCode,
    details: Record<string, unknown>,
  ): void {
    const pending = this.pendingSkillInvokes.get(targetId);
    if (pending && pending.sessionId === sessionId) {
      this.clearPending(pending);
    }

    this.store.finishSessionByToken(streamToken, "error", code);
    this.store.addAudit(actor, "alexa.invoke", targetId, "failure", {
      sessionId,
      code,
      ...details,
    });
    this.metrics.setActiveSessions(this.store.countActiveSessions());
  }

  private clearPendingByTarget(targetId: number): void {
    const pending = this.pendingSkillInvokes.get(targetId);
    if (pending) {
      this.clearPending(pending);
    }
  }

  private clearPending(pending: PendingSkillInvoke): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const current = this.pendingSkillInvokes.get(pending.targetId);
    if (current && current.sessionId === pending.sessionId) {
      this.pendingSkillInvokes.delete(pending.targetId);
    }
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
