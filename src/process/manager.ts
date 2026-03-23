import fs from "node:fs";
import path from "node:path";
import { ChildProcess, execFileSync, spawnSync, spawn } from "node:child_process";
import { logger } from "../logger";
import { ErrorCode, ManagedProcessInfo, Target } from "../types";

interface RuntimeProcess {
  target: Target;
  shairport: ChildProcess | null;
  ffmpeg: ChildProcess | null;
  monitorTimer: NodeJS.Timeout | null;
  playlistPath: string;
  hlsDir: string;
  fifoPath: string;
  hadAudio: boolean;
  lastPlaylistMtimeMs: number;
  lastAudioAt: number;
  state: "starting" | "running" | "stopped" | "error";
}

interface ProcessManagerOptions {
  shairportBin: string;
  ffmpegBin: string;
  fifoRoot: string;
  hlsRoot: string;
  shairportConfigRoot: string;
  ffmpegBitrate: string;
  hlsSegmentSeconds: number;
  hlsListSize: number;
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
    const desired = targets.filter((target) => target.type === "device" && target.enabled === 1 && target.status === "active");
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
      lastPlaylistMtimeMs: runtime.lastPlaylistMtimeMs,
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
    if (target.type === "bluetooth" && target.bluetooth_mac) {
      this.startBluetoothTarget(target);
      return;
    }
    this.startHlsTarget(target);
  }

  private startHlsTarget(target: Target): void {
    const hlsDir = path.join(this.options.hlsRoot, String(target.id));
    const fifoPath = path.join(this.options.fifoRoot, `${target.id}.pcm`);
    const playlistPath = path.join(hlsDir, "index.m3u8");

    fs.mkdirSync(hlsDir, { recursive: true });
    fs.mkdirSync(this.options.shairportConfigRoot, { recursive: true });

    if (!fs.existsSync(fifoPath)) {
      try {
        execFileSync("mkfifo", [fifoPath]);
      } catch (error) {
        logger.error("mkfifo failed", {
          targetId: target.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.options.onTargetError(target, "TRANSCODER_FAILED", "mkfifo failed");
        return;
      }
    }

    const runtime: RuntimeProcess = {
      target,
      shairport: null,
      ffmpeg: null,
      monitorTimer: null,
      playlistPath,
      hlsDir,
      fifoPath,
      hadAudio: false,
      lastPlaylistMtimeMs: 0,
      lastAudioAt: 0,
      state: "starting",
    };

    if (!this.options.spawnProcesses) {
      runtime.state = "running";
      this.processes.set(target.id, runtime);
      return;
    }

    try {
      const shairportPorts = this.getShairportPorts(target.id);
      const shairportConfigPath = this.writeShairportConfig(target, fifoPath, shairportPorts);
      const shairport = spawn(this.options.shairportBin, ["-c", shairportConfigPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const shairportErrLines: string[] = [];
      const ffmpegErrLines: string[] = [];

      shairport.stdout.on("data", (chunk) => {
        logger.debug("shairport stdout", { targetId: target.id, output: chunk.toString() });
      });
      shairport.stderr.on("data", (chunk) => {
        const output = chunk.toString();
        logger.debug("shairport stderr", { targetId: target.id, output });
        this.pushRecentLogLines(shairportErrLines, output);
      });
      shairport.on("exit", (code) => {
        if (runtime.state === "stopped") {
          return;
        }
        runtime.state = "error";
        const details = this.formatProcessExitDetails("shairport", code, shairportErrLines);
        logger.error("shairport exited", { targetId: target.id, code, details });
        this.options.onTargetError(target, "TRANSCODER_FAILED", details);
      });

      const ffmpeg = spawn(
        this.options.ffmpegBin,
        [
          "-hide_banner",
          "-nostdin",
          "-f",
          "s16le",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-i",
          fifoPath,
          "-c:a",
          "aac",
          "-b:a",
          this.options.ffmpegBitrate,
          "-f",
          "hls",
          "-hls_time",
          String(this.options.hlsSegmentSeconds),
          "-hls_list_size",
          String(this.options.hlsListSize),
          "-hls_flags",
          "delete_segments+append_list",
          "-y",
          path.join(hlsDir, "index.m3u8"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      ffmpeg.stdout.on("data", (chunk) => {
        logger.debug("ffmpeg stdout", { targetId: target.id, output: chunk.toString() });
      });
      ffmpeg.stderr.on("data", (chunk) => {
        const output = chunk.toString();
        logger.debug("ffmpeg stderr", { targetId: target.id, output });
        this.pushRecentLogLines(ffmpegErrLines, output);
      });
      ffmpeg.on("exit", (code) => {
        if (runtime.state === "stopped") {
          return;
        }
        runtime.state = "error";
        const details = this.formatProcessExitDetails("ffmpeg", code, ffmpegErrLines);
        logger.error("ffmpeg exited", { targetId: target.id, code, details });
        this.options.onTargetError(target, "TRANSCODER_FAILED", details);
      });

      runtime.shairport = shairport;
      runtime.ffmpeg = ffmpeg;
      runtime.state = "running";
      runtime.monitorTimer = setInterval(() => {
        this.monitorPlaylist(runtime);
      }, this.options.monitorIntervalMs);
      runtime.monitorTimer.unref();

      this.processes.set(target.id, runtime);
      logger.info("target process started", {
        targetId: target.id,
        shairportPid: shairport.pid,
        ffmpegPid: ffmpeg.pid,
        raopPort: shairportPorts.raopPort,
        udpPortBase: shairportPorts.udpPortBase,
      });
    } catch (error) {
      logger.error("failed to start target", {
        targetId: target.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.options.onTargetError(target, "TRANSCODER_FAILED", "startTarget failed");
      if (runtime.shairport?.pid) {
        runtime.shairport.kill("SIGTERM");
      }
      if (runtime.ffmpeg?.pid) {
        runtime.ffmpeg.kill("SIGTERM");
      }
      runtime.state = "error";
    }
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
      monitorTimer: null,
      playlistPath: "",
      hlsDir: "",
      fifoPath,
      hadAudio: false,
      lastPlaylistMtimeMs: 0,
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

  private monitorPlaylist(runtime: RuntimeProcess): void {
    try {
      const stats = fs.statSync(runtime.playlistPath);
      if (stats.mtimeMs > runtime.lastPlaylistMtimeMs) {
        runtime.lastPlaylistMtimeMs = stats.mtimeMs;
        runtime.lastAudioAt = Date.now();
        if (!runtime.hadAudio) {
          runtime.hadAudio = true;
          this.options.onAudioStart(runtime.target);
        }
      } else if (runtime.hadAudio && Date.now() - runtime.lastAudioAt > 20000) {
        runtime.hadAudio = false;
        this.options.onAudioStop(runtime.target);
      }
    } catch {
      if (runtime.hadAudio && Date.now() - runtime.lastAudioAt > 20000) {
        runtime.hadAudio = false;
        this.options.onAudioStop(runtime.target);
      }
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

    if (runtime.monitorTimer) {
      clearInterval(runtime.monitorTimer);
      runtime.monitorTimer = null;
    }

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
