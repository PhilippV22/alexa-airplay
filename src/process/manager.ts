import fs from "node:fs";
import path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { logger } from "../logger";
import { ErrorCode, ManagedProcessInfo, Target } from "../types";

interface RuntimeProcess {
  target: Target;
  shairport: ChildProcess | null;
  btRetryTimer: NodeJS.Timeout | null;
  btConnected: boolean;
  state: "starting" | "running" | "stopped" | "error";
}

interface ProcessManagerOptions {
  shairportBin: string;
  ffmpegBin: string;       // kept for config compat, unused
  fifoRoot: string;        // kept for config compat, unused
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
      ffmpegPid: null,
      state: runtime.state,
    }));
  }

  getActiveProcessCount(): number {
    let total = 0;
    for (const runtime of this.processes.values()) {
      if (runtime.shairport?.pid) total += 1;
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
    const mac = target.bluetooth_mac!;

    fs.mkdirSync(this.options.shairportConfigRoot, { recursive: true });

    const runtime: RuntimeProcess = {
      target,
      shairport: null,
      btRetryTimer: null,
      btConnected: false,
      state: "starting",
    };

    this.processes.set(target.id, runtime);

    if (!this.options.spawnProcesses) {
      runtime.state = "running";
      return;
    }

    // Phase 1: Start shairport with ALSA backend so the AirPlay receiver is
    // always visible. Shairport opens the BlueALSA ALSA device only during an
    // active AirPlay session, so the Echo will not disconnect due to silence.
    try {
      const shairportPorts = this.getShairportPorts(target.id);
      const shairportConfigPath = this.writeShairportConfig(target, mac, shairportPorts);
      const shairport = spawn(this.options.shairportBin, ["-c", shairportConfigPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const shairportErrLines: string[] = [];

      shairport.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        this.pushRecentLogLines(shairportErrLines, text);
        logger.info("shairport stderr", { targetId: target.id, output: text.trim().slice(0, 200) });
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

    // Phase 2: Connect BT so BlueALSA sees the device when shairport needs it.
    const tryConnect = () => {
      if (runtime.state === "stopped") return;
      if (runtime.btConnected) return;
      this.tryConnectBt(runtime, target, mac);
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

  private tryConnectBt(
    runtime: RuntimeProcess,
    target: Target,
    mac: string,
  ): void {
    this.enqueueBtConnect(() => {
      if (runtime.state === "stopped" || runtime.btConnected) {
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

        const alreadyConnected = output.includes("AlreadyConnected") || output.includes("Already connected");
        const connectionBusy = output.includes("br-connection-busy");
        const success = code === 0 || output.includes("Connection successful") || alreadyConnected || connectionBusy;

        if (!success) {
          logger.info("BT not available yet, will retry", { targetId: target.id, mac, code, output: output.slice(0, 120) });
          return;
        }

        logger.info("BT connected", { targetId: target.id, mac });
        runtime.btConnected = true;
        this.options.onAudioStart(runtime.target);
      });
    });
  }

  private writeShairportConfig(target: Target, mac: string, ports: ShairportPorts): string {
    const confPath = path.join(this.options.shairportConfigRoot, `target-${target.id}.conf`);
    const safeName = target.airplay_name.replace(/"/g, "");

    // Use ALSA backend pointing directly at the BlueALSA PCM device.
    // Shairport opens the device only during an active session, avoiding
    // the A2DP silence-timeout that plagued the old pipe+ffmpeg approach.
    const content = [
      `general = {`,
      `  name = "${safeName}";`,
      `  output_backend = "alsa";`,
      `  port = ${ports.raopPort};`,
      `  udp_port_base = ${ports.udpPortBase};`,
      `  udp_port_range = ${ports.udpPortRange};`,
      `};`,
      ``,
      `alsa = {`,
      `  output_device = "bluealsa:DEV=${mac}";`,
      `  mixer_control_name = "";`,
      `};`,
      ``,
    ].join("\n");

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

    if (runtime.btConnected) {
      runtime.btConnected = false;
      this.options.onAudioStop(runtime.target);
    }

    this.processes.delete(targetId);
    logger.info("target stopped", { targetId });
  }
}
