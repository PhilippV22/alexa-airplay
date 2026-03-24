import fs from "node:fs";
import path from "node:path";
import { ChildProcess, execFileSync, spawnSync, spawn } from "node:child_process";
import { logger } from "../logger";
import { ErrorCode, ManagedProcessInfo, Target } from "../types";

interface RuntimeProcess {
  target: Target;
  shairport: ChildProcess | null;
  ffmpeg: ChildProcess | null;
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

export class ProcessManager {
  private readonly options: ProcessManagerOptions;
  private readonly processes = new Map<number, RuntimeProcess>();

  constructor(options: ProcessManagerOptions) {
    this.options = options;
  }

  async reconcile(targets: Target[]): Promise<void> {
    const desired = targets.filter((target) => target.type === "bluetooth" && target.enabled === 1 && target.status === "active");
    const desiredIds = new Set(desired.map((target) => target.id));

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
      if (runtime.shairport?.pid) {
        total += 1;
      }
      if (runtime.ffmpeg?.pid) {
        total += 1;
      }
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
        logger.error("mkfifo failed (bt)", {
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
      fifoPath,
      hadAudio: false,
      lastAudioAt: 0,
      state: "starting",
    };

    if (!this.options.spawnProcesses) {
      runtime.state = "running";
      this.processes.set(target.id, runtime);
      return;
    }

    // Connect Bluetooth device
    logger.info("connecting bluetooth device", { targetId: target.id, mac });
    const btResult = spawnSync("bluetoothctl", ["connect", mac], { timeout: 15000, encoding: "utf8" });
    if (btResult.status !== 0) {
      const details = (btResult.stderr || btResult.stdout || "").toString().slice(0, 200);
      logger.error("bluetooth connect failed", { targetId: target.id, mac, details });
      this.options.onTargetError(target, "BT_CONNECT_FAILED", `bluetoothctl connect failed: ${details}`);
      return;
    }
    logger.info("bluetooth device connected", { targetId: target.id, mac });

    try {
      const shairportPorts = this.getShairportPorts(target.id);
      const shairportConfigPath = this.writeShairportConfig(target, fifoPath, shairportPorts);
      const shairport = spawn(this.options.shairportBin, ["-c", shairportConfigPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const shairportErrLines: string[] = [];
      const ffmpegErrLines: string[] = [];

      shairport.stderr.on("data", (chunk) => {
        this.pushRecentLogLines(shairportErrLines, chunk.toString());
      });
      shairport.on("exit", (code) => {
        if (runtime.state === "stopped") return;
        runtime.state = "error";
        logger.error("shairport exited (bt)", { targetId: target.id, code });
        this.options.onTargetError(target, "BT_CONNECT_FAILED",
          this.formatProcessExitDetails("shairport", code, shairportErrLines));
      });

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
      ffmpeg.on("exit", (code) => {
        if (runtime.state === "stopped") return;
        runtime.state = "error";
        logger.error("ffmpeg exited (bt)", { targetId: target.id, code });
        this.options.onTargetError(target, "BT_CONNECT_FAILED",
          this.formatProcessExitDetails("ffmpeg", code, ffmpegErrLines));
      });

      runtime.shairport = shairport;
      runtime.ffmpeg = ffmpeg;
      runtime.state = "running";

      // Detect audio: after 3s both processes alive → audio started
      const startTimer = setTimeout(() => {
        if (runtime.state === "running" && !runtime.hadAudio) {
          runtime.hadAudio = true;
          runtime.lastAudioAt = Date.now();
          this.options.onAudioStart(runtime.target);
        }
      }, 3000);
      startTimer.unref();

      // Watchdog: if ffmpeg dies and we had audio → audio stopped
      ffmpeg.on("exit", () => {
        if (runtime.hadAudio) {
          runtime.hadAudio = false;
          this.options.onAudioStop(runtime.target);
        }
      });

      this.processes.set(target.id, runtime);
      logger.info("bluetooth target started", {
        targetId: target.id,
        mac,
        shairportPid: shairport.pid,
        ffmpegPid: ffmpeg.pid,
      });
    } catch (error) {
      logger.error("failed to start bluetooth target", {
        targetId: target.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.options.onTargetError(target, "BT_CONNECT_FAILED", "startBluetoothTarget failed");
      runtime.state = "error";
    }
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
    const lines = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      buffer.push(line);
      if (buffer.length > 20) {
        buffer.shift();
      }
    }
  }

  private formatProcessExitDetails(
    processName: "shairport" | "ffmpeg",
    code: number | null,
    recentLines: string[],
  ): string {
    const parts = [`${processName} exit ${code ?? "null"}`];
    if (recentLines.length > 0) {
      parts.push(recentLines.slice(-4).join(" | "));
    }
    return parts.join(": ");
  }

  private stopTarget(targetId: number): void {
    const runtime = this.processes.get(targetId);
    if (!runtime) {
      return;
    }

    runtime.state = "stopped";

    if (runtime.shairport?.pid) {
      runtime.shairport.kill("SIGTERM");
    }

    if (runtime.ffmpeg?.pid) {
      runtime.ffmpeg.kill("SIGTERM");
    }

    if (runtime.hadAudio) {
      runtime.hadAudio = false;
      this.options.onAudioStop(runtime.target);
    }

    this.processes.delete(targetId);
    logger.info("target process stopped", { targetId });
  }
}
