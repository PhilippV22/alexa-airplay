import fs from "node:fs";
import path from "node:path";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { logger } from "../logger";
import { ErrorCode, ManagedProcessInfo, Target } from "../types";

interface RuntimeProcess {
  target: Target;
  shairport: ChildProcess | null;
  ffmpeg: ChildProcess | null;
  btRetryTimer: NodeJS.Timeout | null;
  fifoPath: string;
  hadAudio: boolean;
  lastAudioAt: number;
  state: "starting" | "running" | "stopped" | "error";
}

interface ProcessManagerOptions {
  shairportBin: string;
  ffmpegBin: string;
  fifoRoot: string;
  shairportConfigRoot: string;
  monitorIntervalMs: number;
  spawnProcesses: boolean;
  onAudioStart: (target: Target) => void;
  onAudioStop: (target: Target) => void;
  onTargetError: (target: Target, errorCode: ErrorCode, details?: string) => void;
}

interface ShairportPorts {
  raopPort: number;
  udpPortBase: number;
  udpPortRange: number;
}

const BT_RETRY_INTERVAL_MS = 15_000;

export class ProcessManager {
  private readonly options: ProcessManagerOptions;
  private readonly processes = new Map<number, RuntimeProcess>();
  private btConnecting = false;
  private readonly btConnectQueue: Array<() => void> = [];

  constructor(options: ProcessManagerOptions) {
    this.options = options;
  }

  async reconcile(targets: Target[]): Promise<void> {
    const desired = targets.filter((t) => t.type === "bluetooth" && t.enabled === 1 && t.status === "active");
    const desiredIds = new Set(desired.map((t) => t.id));

    for (const [targetId] of this.processes) {
      if (!desiredIds.has(targetId)) {
        this.stopTarget(targetId);
      }
    }

    for (const target of desired) {
      const existing = this.processes.get(target.id);
      if (existing) {
        existing.target = target;
        continue;
      }
      this.startTarget(target);
    }
  }

  getProcessInfos(): ManagedProcessInfo[] {
    return Array.from(this.processes.values()).map((runtime) => ({
      targetId: runtime.target.id,
      shairportPid: runtime.shairport?.pid ?? null,
      ffmpegPid: runtime.ffmpeg?.pid ?? null,
      state: runtime.state,
    }));
  }

  getActiveProcessCount(): number {
    let total = 0;
    for (const runtime of this.processes.values()) {
      if (runtime.shairport?.pid) total += 1;
      if (runtime.ffmpeg?.pid) total += 1;
    }
    return total;
  }

  stopAll(): void {
    for (const targetId of Array.from(this.processes.keys())) {
      this.stopTarget(targetId);
    }
  }

  private startTarget(target: Target): void {
    this.startBluetoothTarget(target);
  }

  private startBluetoothTarget(target: Target): void {
    const fifoPath = path.join(this.options.fifoRoot, `${target.id}.pcm`);
    const mac = target.bluetooth_mac!;

    fs.mkdirSync(this.options.shairportConfigRoot, { recursive: true });

    if (!fs.existsSync(fifoPath)) {
      try {
        execFileSync("mkfifo", [fifoPath]);
      } catch (error) {
        logger.error("mkfifo failed", {
          targetId: target.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.options.onTargetError(target, "BT_CONNECT_FAILED", "mkfifo failed");
        return;
      }
    }

    const runtime: RuntimeProcess = {
      target,
      shairport: null,
      ffmpeg: null,
      btRetryTimer: null,
      fifoPath,
      hadAudio: false,
      lastAudioAt: 0,
      state: "starting",
    };

    this.processes.set(target.id, runtime);

    if (!this.options.spawnProcesses) {
      runtime.state = "running";
      return;
    }

    // Phase 1: Start shairport immediately so the AirPlay receiver is always visible.
    try {
      const shairportPorts = this.getShairportPorts(target.id);
      const shairportConfigPath = this.writeShairportConfig(target, fifoPath, shairportPorts);
      const shairport = spawn(this.options.shairportBin, ["-c", shairportConfigPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const shairportErrLines: string[] = [];

      shairport.stderr.on("data", (chunk) => {
        this.pushRecentLogLines(shairportErrLines, chunk.toString());
      });
      shairport.on("exit", (code) => {
        if (runtime.state === "stopped") return;
        runtime.state = "error";
        logger.error("shairport exited", { targetId: target.id, code });
        this.options.onTargetError(target, "TRANSCODER_FAILED",
          this.formatProcessExitDetails("shairport", code, shairportErrLines));
      });

      runtime.shairport = shairport;
      runtime.state = "running";
      logger.info("shairport started", {
        targetId: target.id,
        airplayName: target.airplay_name,
        shairportPid: shairport.pid,
      });
    } catch (error) {
      logger.error("failed to start shairport", {
        targetId: target.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.options.onTargetError(target, "TRANSCODER_FAILED", "shairport start failed");
      return;
    }

    // Phase 2: Connect BT + start ffmpeg in background, retry every 15s until success.
    const tryConnect = () => {
      if (runtime.state === "stopped") return;
      if (runtime.ffmpeg?.pid) return; // already running
      this.tryConnectBtAndStartFfmpeg(runtime, target, mac, fifoPath);
    };

    tryConnect();
    runtime.btRetryTimer = setInterval(tryConnect, BT_RETRY_INTERVAL_MS);
    runtime.btRetryTimer.unref();
  }

  private enqueueBtConnect(fn: () => void): void {
    this.btConnectQueue.push(fn);
    this.drainBtConnectQueue();
  }

  private drainBtConnectQueue(): void {
    if (this.btConnecting || this.btConnectQueue.length === 0) return;
    this.btConnecting = true;
    const next = this.btConnectQueue.shift()!;
    next();
  }

  private tryConnectBtAndStartFfmpeg(
    runtime: RuntimeProcess,
    target: Target,
    mac: string,
    fifoPath: string,
  ): void {
    this.enqueueBtConnect(() => {
      logger.debug("trying BT connect", { targetId: target.id, mac });

      if (runtime.state === "stopped" || runtime.ffmpeg?.pid) {
        this.btConnecting = false;
        this.drainBtConnectQueue();
        return;
      }

      const btProcess = spawn("bluetoothctl", ["connect", mac], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      btProcess.stdout.on("data", (d: Buffer) => { output += d.toString(); });
      btProcess.stderr.on("data", (d: Buffer) => { output += d.toString(); });

      const killTimer = setTimeout(() => btProcess.kill(), 15_000);

      btProcess.on("close", (code) => {
        clearTimeout(killTimer);
        this.btConnecting = false;
        this.drainBtConnectQueue();

        if (runtime.state === "stopped") return;
        if (runtime.ffmpeg?.pid) return;

        const alreadyConnected = output.includes("AlreadyConnected") || output.includes("Already connected");
        const connectionBusy = output.includes("br-connection-busy");
        const success = code === 0 || output.includes("Connection successful") || alreadyConnected || connectionBusy;
        if (!success) {
          logger.info("BT not available yet, will retry", { targetId: target.id, mac, code, output: output.slice(0, 120) });
          return;
        }

        // Give BlueALSA time to register the A2DP profile after BT connect.
        const a2dpDelay = alreadyConnected ? 0 : 2000;
        setTimeout(() => {
          if (runtime.state === "stopped" || runtime.ffmpeg?.pid) return;

          logger.info("BT connected, starting ffmpeg", { targetId: target.id, mac });

          const ffmpegErrLines: string[] = [];
          const ffmpeg = spawn(
            this.options.ffmpegBin,
            [
              "-hide_banner", "-nostdin",
              "-f", "s16le", "-ar", "44100", "-ac", "2",
              "-i", fifoPath,
              "-f", "alsa",
              `bluealsa:DEV=${mac},PROFILE=a2dp`,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );

          ffmpeg.stderr.on("data", (chunk) => {
            this.pushRecentLogLines(ffmpegErrLines, chunk.toString());
          });

          ffmpeg.on("exit", (exitCode) => {
            if (runtime.state === "stopped") return;
            logger.warn("ffmpeg exited, waiting for BT reconnect", {
              targetId: target.id,
              code: exitCode,
              details: ffmpegErrLines.slice(-2).join(" | "),
            });
            runtime.ffmpeg = null;
            if (runtime.hadAudio) {
              runtime.hadAudio = false;
              this.options.onAudioStop(runtime.target);
            }
          });

          runtime.ffmpeg = ffmpeg;

          // Detect audio start: after 3s with both processes alive
          const startTimer = setTimeout(() => {
            if (runtime.state === "running" && !runtime.hadAudio && runtime.ffmpeg?.pid) {
              runtime.hadAudio = true;
              runtime.lastAudioAt = Date.now();
              this.options.onAudioStart(runtime.target);
            }
          }, 3000);
          startTimer.unref();

          logger.info("bluetooth target fully started", {
            targetId: target.id,
            mac,
            shairportPid: runtime.shairport?.pid,
            ffmpegPid: ffmpeg.pid,
          });
        }, a2dpDelay);
      });
    });
  }

  private writeShairportConfig(target: Target, fifoPath: string, ports: ShairportPorts): string {
    const confPath = path.join(this.options.shairportConfigRoot, `target-${target.id}.conf`);
    const safeName = target.airplay_name.replace(/"/g, "");

    const content = `general = {\n  name = \"${safeName}\";\n  output_backend = \"pipe\";\n  port = ${ports.raopPort};\n  udp_port_base = ${ports.udpPortBase};\n  udp_port_range = ${ports.udpPortRange};\n};\n\npipe = {\n  name = \"${fifoPath}\";\n  format = \"S16\";\n};\n`;

    fs.writeFileSync(confPath, content, { encoding: "utf8" });
    return confPath;
  }

  private getShairportPorts(targetId: number): ShairportPorts {
    const slot = ((targetId - 1) % 3500 + 3500) % 3500;
    return {
      raopPort: 5500 + slot,
      udpPortBase: 20000 + slot * 10,
      udpPortRange: 10,
    };
  }

  private pushRecentLogLines(buffer: string[], output: string): void {
    const lines = output.split(/\r?\n/g).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      buffer.push(line);
      if (buffer.length > 20) buffer.shift();
    }
  }

  private formatProcessExitDetails(
    processName: "shairport" | "ffmpeg",
    code: number | null,
    recentLines: string[],
  ): string {
    const parts = [`${processName} exit ${code ?? "null"}`];
    if (recentLines.length > 0) parts.push(recentLines.slice(-4).join(" | "));
    return parts.join(": ");
  }

  private stopTarget(targetId: number): void {
    const runtime = this.processes.get(targetId);
    if (!runtime) return;

    runtime.state = "stopped";

    if (runtime.btRetryTimer) {
      clearInterval(runtime.btRetryTimer);
      runtime.btRetryTimer = null;
    }

    if (runtime.shairport?.pid) runtime.shairport.kill("SIGTERM");
    if (runtime.ffmpeg?.pid) runtime.ffmpeg.kill("SIGTERM");

    if (runtime.hadAudio) {
      runtime.hadAudio = false;
      this.options.onAudioStop(runtime.target);
    }

    this.processes.delete(targetId);
    logger.info("target stopped", { targetId });
  }
}
