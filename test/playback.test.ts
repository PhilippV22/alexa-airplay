import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlexaAdapter, InvokeStreamOptions } from "../src/alexa/adapter";
import { AppError } from "../src/errors";
import { MetricsService } from "../src/metrics";
import { PlaybackService } from "../src/playback";
import { Store } from "../src/store";
import { Target } from "../src/types";

class FakeAlexaAdapter extends AlexaAdapter {
  public readonly calls: Array<{
    targetId: number;
    streamToken: string;
    streamUrl: string;
    invocationPrefix: string | null;
  }> = [];

  public readonly failingCalls = new Set<number>();

  constructor() {
    super({ mode: "mock" });
  }

  override async invokeStream(
    target: Target,
    streamToken: string,
    streamUrl: string,
    options?: InvokeStreamOptions,
  ): Promise<void> {
    const callNumber = this.calls.length + 1;
    this.calls.push({
      targetId: target.id,
      streamToken,
      streamUrl,
      invocationPrefix: options?.invocationPrefix ?? null,
    });

    if (this.failingCalls.has(callNumber)) {
      const err = new Error("invoke failed") as Error & { code?: string };
      err.code = "ALEXA_INVOKE_FAILED";
      throw err;
    }
  }
}

describe("playback service", () => {
  let tmpRoot = "";
  let store: Store;
  let metrics: MetricsService;
  let adapter: FakeAlexaAdapter;
  let playback: PlaybackService;
  let target: Target;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "airbridge-playback-test-"));
    store = new Store(path.join(tmpRoot, "airbridge.sqlite"));
    metrics = new MetricsService();
    adapter = new FakeAlexaAdapter();
    playback = new PlaybackService(store, adapter, "https://stream.example.com", metrics, {
      primaryInvocationPrefix: "ask air bridge to play token",
      skillInvocationName: "air bridge",
      invocationPrefixFallbacks: "",
      skillInvokeTimeoutMs: 6000,
      skillInvokeRetryCount: 2,
    });
    target = store.createTarget({
      name: "Wohnzimmer Echo",
      type: "device",
      alexa_device_id: "A3TESTSERIAL",
      enabled: true,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    store.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("keeps session buffering until skill invoke confirmation", async () => {
    const session = await playback.startForTarget(target.id, "test");

    expect(adapter.calls).toHaveLength(1);
    expect(store.getSession(session.id)?.state).toBe("buffering");

    playback.confirmSkillInvoke(target.id, session.stream_token);
    expect(store.getSession(session.id)?.state).toBe("playing");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(adapter.calls).toHaveLength(1);
  });

  it("retries and fails when skill invoke does not arrive", async () => {
    const session = await playback.startForTarget(target.id, "test");
    expect(adapter.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(adapter.calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(adapter.calls).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(6_000);
    const failedSession = store.getSession(session.id);
    expect(failedSession?.state).toBe("error");
    expect(failedSession?.error_code).toBe("ALEXA_INVOKE_FAILED");

    const failureAudit = store
      .listAudit()
      .find((entry) => entry.action === "alexa.invoke" && entry.result === "failure");
    if (!failureAudit) {
      throw new Error("Expected failure audit entry");
    }
    const details = JSON.parse(failureAudit.details_json) as Record<string, unknown>;
    expect(details.reason).toBe("skill_not_invoked");
  });

  it("marks session playing when skill invoke arrives during retries", async () => {
    const session = await playback.startForTarget(target.id, "test");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(adapter.calls).toHaveLength(2);

    playback.confirmSkillInvoke(target.id, session.stream_token);
    expect(store.getSession(session.id)?.state).toBe("playing");

    await vi.advanceTimersByTimeAsync(24_000);
    expect(adapter.calls).toHaveLength(2);

    const failureAudit = store
      .listAudit()
      .find((entry) => entry.action === "alexa.invoke" && entry.result === "failure");
    expect(failureAudit).toBeUndefined();
  });

  it("stopForTarget clears pending retry timer", async () => {
    const session = await playback.startForTarget(target.id, "test");
    expect(adapter.calls).toHaveLength(1);

    playback.stopForTarget(target.id, "test");
    expect(store.getSession(session.id)?.state).toBe("stopped");

    await vi.advanceTimersByTimeAsync(24_000);
    expect(adapter.calls).toHaveLength(1);
  });

  it("fails immediately when initial invoke throws", async () => {
    adapter.failingCalls.add(1);

    await expect(playback.startForTarget(target.id, "test")).rejects.toBeInstanceOf(AppError);
    expect(adapter.calls).toHaveLength(1);

    const sessions = store.listSessions(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].state).toBe("error");
    expect(sessions[0].error_code).toBe("ALEXA_INVOKE_FAILED");

    await vi.advanceTimersByTimeAsync(24_000);
    expect(adapter.calls).toHaveLength(1);
  });
});
