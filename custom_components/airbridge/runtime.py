"""Runtime process management for AirBridge."""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
MAC_IN_TEXT_RE = re.compile(r"\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b", re.IGNORECASE)
ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")
LOG_LEVELS = {"trace", "debug", "info", "warning", "error"}
BLUETOOTH_REFUSED_MARKERS = (
    "br-connection-refused",
    "status 0x0b",
    "rejected",
)
BLUETOOTH_PAIRING_FAILED_MARKERS = (
    "bluetooth pairing failed",
    "bluetooth target is not paired",
    "failed to pair",
)
BLUEALSA_PCM_MISSING_MARKERS = (
    "no such bluealsa audio device",
    "couldn't get bluealsa pcm",
    "pcm not found",
    "output_device_error_19",
    "bluealsa a2dp audio device is not ready",
)
AIRPLAY_REQUIRED_COMMANDS = ("shairport-sync", "bluealsa")
DISCOVERY_REQUIRED_COMMANDS = ("avahi-daemon",)
BLUETOOTH_REQUIRED_COMMANDS = ("bluetoothctl", "bluealsa-aplay", "aplay")
ALL_REQUIRED_COMMANDS = (
    *AIRPLAY_REQUIRED_COMMANDS,
    *DISCOVERY_REQUIRED_COMMANDS,
    *BLUETOOTH_REQUIRED_COMMANDS,
)
APK_PACKAGES = (
    "alsa-utils",
    "avahi",
    "bluez",
    "bluez-alsa",
    "bluez-alsa-utils",
    "shairport-sync",
)
APT_PACKAGES = (
    "alsa-utils",
    "avahi-daemon",
    "bluez",
    "bluez-alsa-utils",
    "shairport-sync",
)


class RuntimeConfigError(ValueError):
    """Raised when AirBridge runtime configuration is invalid."""


class CommandUnavailableError(RuntimeError):
    """Raised when a required command is not available."""


@dataclass(frozen=True)
class Target:
    """One configured AirBridge target."""

    id: str
    name: str
    airplay_name: str
    mac: str
    enabled: bool
    adapter: str
    raop_port: int
    udp_port_base: int


@dataclass(frozen=True)
class AirBridgeConfig:
    """Validated AirBridge configuration."""

    log_level: str
    adapter: str
    reconnect_interval_seconds: int
    airplay_port_base: int
    udp_port_base: int
    targets: tuple[Target, ...]


@dataclass
class TargetRuntimeStatus:
    """Current runtime status for one target."""

    target: Target
    state: str = "disabled"
    connected: bool = False
    bluealsa_ready: bool = False
    bluealsa_recovery_attempted: bool = False
    airplay_ready: bool = False
    shairport_pid: int | None = None
    audio_pid: int | None = None
    last_message: str | None = None
    last_error: str | None = None
    recent_output: list[str] = field(default_factory=list)
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def update(self, **changes: object) -> None:
        for key, value in changes.items():
            setattr(self, key, value)
        self.updated_at = datetime.now(timezone.utc).isoformat()


def normalize_mac(mac: object) -> str:
    """Normalize a Bluetooth MAC address."""
    return str(mac).strip().upper()


def redact_mac_addresses(value: object) -> object:
    """Return a copy of a value with MAC addresses redacted."""
    if isinstance(value, str):
        return MAC_IN_TEXT_RE.sub("**REDACTED**", value)
    if isinstance(value, list):
        return [redact_mac_addresses(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_mac_addresses(item) for item in value)
    if isinstance(value, dict):
        return {key: redact_mac_addresses(item) for key, item in value.items()}
    return value


def clean_command_output(value: str) -> str:
    """Clean terminal control characters from command output."""
    text = ANSI_ESCAPE_RE.sub("", value)
    text = text.replace("\r", "\n").replace("\b", "")
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def validate_port(value: int, name: str) -> None:
    """Validate a TCP/UDP port number."""
    if value < 1 or value > 65535:
        raise RuntimeConfigError(f"{name} must be between 1 and 65535")


def build_config(options: dict[str, Any]) -> AirBridgeConfig:
    """Build and validate an AirBridge config from Home Assistant options."""
    log_level = str(options.get("log_level", "info")).strip().lower()
    if log_level not in LOG_LEVELS:
        raise RuntimeConfigError(f"invalid log_level: {log_level}")

    adapter = str(options.get("adapter", "hci0")).strip()
    if not adapter:
        raise RuntimeConfigError("adapter is required")

    reconnect_interval_seconds = int(options.get("reconnect_interval_seconds", 15))
    if reconnect_interval_seconds < 5 or reconnect_interval_seconds > 300:
        raise RuntimeConfigError("reconnect_interval_seconds must be between 5 and 300")

    airplay_port_base = int(options.get("airplay_port_base", 5500))
    udp_port_base = int(options.get("udp_port_base", 20000))
    validate_port(airplay_port_base, "airplay_port_base")
    validate_port(udp_port_base, "udp_port_base")

    raw_targets = options.get("targets", [])
    if not isinstance(raw_targets, list):
        raise RuntimeConfigError("targets must be a list")

    targets: list[Target] = []
    seen_names: set[str] = set()
    for index, raw_target in enumerate(raw_targets):
        if not isinstance(raw_target, dict):
            raise RuntimeConfigError(f"targets[{index}] must be an object")

        name = str(raw_target.get("name", "")).strip()
        airplay_name = str(raw_target.get("airplay_name", "")).strip()
        mac = normalize_mac(raw_target.get("mac", ""))
        enabled = bool(raw_target.get("enabled", False))

        if not name:
            raise RuntimeConfigError(f"targets[{index}].name is required")
        if not airplay_name:
            raise RuntimeConfigError(f"targets[{index}].airplay_name is required")
        if airplay_name in seen_names:
            raise RuntimeConfigError(f"duplicate AirPlay name: {airplay_name}")
        if not MAC_RE.match(mac):
            raise RuntimeConfigError(f"targets[{index}].mac is invalid: {mac}")

        seen_names.add(airplay_name)
        raop_port = airplay_port_base + index
        target_udp_base = udp_port_base + index * 10
        validate_port(raop_port, f"targets[{index}] AirPlay TCP port")
        validate_port(target_udp_base + 9, f"targets[{index}] AirPlay UDP port range")
        targets.append(
            Target(
                id=str(index),
                name=name,
                airplay_name=airplay_name,
                mac=mac,
                enabled=enabled,
                adapter=adapter,
                raop_port=raop_port,
                udp_port_base=target_udp_base,
            )
        )

    return AirBridgeConfig(
        log_level=log_level,
        adapter=adapter,
        reconnect_interval_seconds=reconnect_interval_seconds,
        airplay_port_base=airplay_port_base,
        udp_port_base=udp_port_base,
        targets=tuple(targets),
    )


def escape_shairport_string(value: str) -> str:
    """Escape a string for shairport-sync config."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def bluealsa_device(target: Target) -> str:
    """Return the ALSA device string for a target."""
    return f"bluealsa:DEV={target.mac}"


def render_shairport_config(target: Target, pipe_path: str | None = None) -> str:
    """Render shairport-sync config for one target."""
    pipe_path = pipe_path or f"/tmp/airbridge_target_{target.id}.pcm"
    return (
        "general = {\n"
        f'  name = "{escape_shairport_string(target.airplay_name)}";\n'
        '  output_backend = "pipe";\n'
        f"  port = {target.raop_port};\n"
        f"  udp_port_base = {target.udp_port_base};\n"
        "  udp_port_range = 10;\n"
        '  ignore_volume_control = "no";\n'
        '  volume_control_profile = "flat";\n'
        "  volume_max_db = 0.0;\n"
        "  volume_range_db = 30;\n"
        "  audio_backend_buffer_desired_length_in_seconds = 1.500;\n"
        "  audio_backend_buffer_interpolation_threshold_in_seconds = 0.750;\n"
        "  audio_backend_silent_lead_in_time = 1.500;\n"
        "};\n\n"
        "pipe = {\n"
        f'  name = "{escape_shairport_string(pipe_path)}";\n'
        "  output_rate = 44100;\n"
        '  output_format = "S16_LE";\n'
        "  output_channels = 2;\n"
        "};\n\n"
        "metadata = {\n"
        '  enabled = "no";\n'
        "};\n"
    )


class AirBridgeManager:
    """Manage AirBridge runtime processes."""

    def __init__(self, runtime_dir: str, options: dict[str, Any]) -> None:
        self.runtime_dir = Path(runtime_dir)
        self.options = options
        self.config = build_config(options)
        self.global_state = "starting"
        self.global_error: str | None = None
        self.dependency_errors: list[str] = []
        self.command_paths: dict[str, str | None] = {}
        self.auto_install_state = "not_started"
        self.auto_install_error: str | None = None
        self.auto_install_output: list[str] = []
        self._auto_install_attempted = False
        self._listeners: set[Callable[[], None]] = set()
        self._monitor_task: asyncio.Task | None = None
        self._bluealsa_process: asyncio.subprocess.Process | None = None
        self._bluealsa_help: str | None = None
        self._audio_processes: dict[str, asyncio.subprocess.Process] = {}
        self._audio_log_tasks: dict[str, asyncio.Task] = {}
        self._shairport_processes: dict[str, asyncio.subprocess.Process] = {}
        self._shairport_log_tasks: dict[str, asyncio.Task] = {}
        self._target_statuses = {
            target.id: TargetRuntimeStatus(
                target=target,
                state="disabled" if not target.enabled else "configured",
            )
            for target in self.config.targets
        }

    @property
    def target_ids(self) -> list[str]:
        return list(self._target_statuses)

    def target(self, target_id: str) -> Target:
        return self._target_statuses[target_id].target

    def target_status(self, target_id: str) -> TargetRuntimeStatus:
        return self._target_statuses[target_id]

    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.add(listener)

        def remove_listener() -> None:
            self._listeners.discard(listener)

        return remove_listener

    async def async_start(self) -> None:
        await self.async_stop(stop_monitor=False)
        await self._stop_orphan_shairport_processes()
        await self._stop_orphan_audio_processes()
        await self._stop_orphan_bluealsa_processes()
        self._write_configs()
        self.global_state = "running"
        self.global_error = None
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        self._notify()

    async def async_restart(self) -> None:
        await self.async_start()

    async def async_reconnect(self, target_id: str | None = None) -> None:
        targets = self._enabled_targets_for_action(target_id)
        if not targets:
            self._notify()
            return
        if not await self._prepare_bluetooth_for_action(targets):
            self._notify()
            return

        await self._ensure_bluealsa()
        for target in targets:
            self._target_statuses[target.id].bluealsa_recovery_attempted = False
            await self._run_target_action(
                target,
                "Bluetooth reconnect",
                self._reconnect_target,
            )
        self._update_global_state()
        self._notify()

    async def async_pair(self, target_id: str | None = None) -> None:
        """Pair, trust and connect one or all targets from a Home Assistant action."""
        targets = self._enabled_targets_for_action(target_id)
        if not targets:
            self._notify()
            return
        if not await self._prepare_bluetooth_for_action(targets):
            self._notify()
            return

        await self._ensure_bluealsa()
        for target in targets:
            self._target_statuses[target.id].bluealsa_recovery_attempted = False
            await self._run_target_action(
                target,
                "Bluetooth pair",
                self._pair_target,
            )
        self._update_global_state()
        self._notify()

    async def async_forget(self, target_id: str | None = None) -> None:
        """Remove the Bluetooth pairing for one or all targets from a HA action."""
        targets = self._enabled_targets_for_action(target_id)
        if not targets:
            self._notify()
            return
        if not await self._prepare_bluetooth_for_action(targets):
            self._notify()
            return

        for target in targets:
            await self._run_target_action(
                target,
                "Bluetooth forget",
                self._forget_target,
            )
        self._update_global_state()
        self._notify()

    async def async_stop(self, stop_monitor: bool = True) -> None:
        if stop_monitor and self._monitor_task:
            self._monitor_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._monitor_task
            self._monitor_task = None

        for process in list(self._shairport_processes.values()):
            await self._stop_process(process)
        self._shairport_processes.clear()
        for task in list(self._shairport_log_tasks.values()):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._shairport_log_tasks.clear()

        for process in list(self._audio_processes.values()):
            await self._stop_process(process)
        self._audio_processes.clear()
        for task in list(self._audio_log_tasks.values()):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._audio_log_tasks.clear()
        for target in self.config.targets:
            with contextlib.suppress(FileNotFoundError):
                self._audio_pipe_path(target).unlink()

        if self._bluealsa_process:
            await self._stop_process(self._bluealsa_process)
            self._bluealsa_process = None

    def diagnostics(self) -> dict[str, Any]:
        return {
            "global_state": self.global_state,
            "global_error": self.global_error,
            "dependency_errors": self.dependency_errors,
            "command_paths": self.command_paths,
            "auto_install_state": self.auto_install_state,
            "auto_install_error": self.auto_install_error,
            "auto_install_output": self.auto_install_output[-20:],
            "runtime_advice": self.runtime_advice(),
            "targets": {
                target_id: {
                    "state": status.state,
                    "connected": status.connected,
                    "bluealsa_ready": status.bluealsa_ready,
                    "bluealsa_recovery_attempted": status.bluealsa_recovery_attempted,
                    "airplay_ready": status.airplay_ready,
                    "shairport_pid": status.shairport_pid,
                    "audio_pid": status.audio_pid,
                    "last_message": status.last_message,
                    "last_error": status.last_error,
                    "recent_output": status.recent_output[-10:],
                    "updated_at": status.updated_at,
                }
                for target_id, status in self._target_statuses.items()
            },
        }

    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    def runtime_advice(self) -> str | None:
        """Return a concise user-facing runtime hint."""
        missing = [cmd for cmd, path in self.command_paths.items() if path is None]
        if not missing:
            for status in self._target_statuses.values():
                advice = self._target_runtime_advice(status)
                if advice:
                    return advice
            return None
        if self.auto_install_state == "failed" and self.auto_install_error:
            return (
                "Automatic package install failed: "
                f"{self.auto_install_error}. Run the README requirements one-liner "
                "on the Docker host, then restart Home Assistant."
            )
        if self.auto_install_state == "skipped" and self.auto_install_error:
            return (
                f"Automatic package install skipped: {self.auto_install_error}. "
                "Run the README requirements one-liner on the Docker host, then "
                "restart Home Assistant."
            )
        return (
            "Missing runtime commands inside Home Assistant: "
            f"{', '.join(missing)}. For Home Assistant Container, run the README "
            "requirements one-liner on the Docker host and restart the container."
        )

    @staticmethod
    def _target_runtime_advice(status: TargetRuntimeStatus) -> str | None:
        """Return a concise hint for a target-level runtime problem."""
        if not status.target.enabled:
            return None

        output = "\n".join([status.last_error or "", *status.recent_output]).lower()
        if any(marker in output for marker in BLUETOOTH_REFUSED_MARKERS):
            return (
                f"{status.target.airplay_name}: the Echo is refusing the Bluetooth "
                "connection. Make sure it is not connected to another phone or "
                "computer. If it was paired before, press the Bluetooth forget "
                "button, put the Echo in Bluetooth pairing mode, then press the "
                "Bluetooth pair button."
            )
        if any(marker in output for marker in BLUETOOTH_PAIRING_FAILED_MARKERS):
            return (
                f"{status.target.airplay_name}: Bluetooth pairing did not complete. "
                "Put the Echo in Bluetooth pairing mode, then press the Bluetooth "
                "pair button in Home Assistant."
            )
        if status.connected and not status.bluealsa_ready:
            return (
                f"{status.target.airplay_name}: Bluetooth is connected, but BlueALSA "
                "cannot open the A2DP playback output for this Echo yet. Press "
                "Bluetooth reconnect; if it still stays this way, press Bluetooth "
                "forget, put the Echo in pairing mode, then press Bluetooth pair."
            )
        if any(marker in output for marker in BLUEALSA_PCM_MISSING_MARKERS):
            return (
                f"{status.target.airplay_name}: AirPlay is visible, but BlueALSA "
                "does not have a Bluetooth audio device for this Echo yet. Connect "
                "the Echo over Bluetooth first, then try AirPlay again."
            )
        if status.connected and status.bluealsa_ready:
            return None
        if status.state == "warning":
            return (
                f"{status.target.airplay_name}: Bluetooth is not connected. Put the "
                "Echo in Bluetooth pairing or connect mode and press reconnect."
            )
        return None

    def _write_configs(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        for old_config in self.runtime_dir.glob("target_*.shairport-sync.conf"):
            old_config.unlink()

        for target in self.config.targets:
            if not target.enabled:
                continue
            config_path = self._config_path(target)
            config_path.write_text(
                render_shairport_config(target, str(self._audio_pipe_path(target))),
                encoding="utf-8",
            )
            self._target_statuses[target.id].update(
                state="configured",
                last_message="AirPlay receiver configured",
                last_error=None,
            )

    def _config_path(self, target: Target) -> Path:
        return self.runtime_dir / f"target_{target.id}.shairport-sync.conf"

    def _audio_pipe_path(self, target: Target) -> Path:
        return self.runtime_dir / f"target_{target.id}.pcm"

    async def _monitor_loop(self) -> None:
        while True:
            try:
                await self._monitor_once()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - keep integration alive
                self.global_state = "warning"
                self.global_error = str(err)
                self._notify()
            await asyncio.sleep(self.config.reconnect_interval_seconds)

    async def _monitor_once(self) -> None:
        self.dependency_errors = []
        self._refresh_command_paths()
        await self._maybe_auto_install_dependencies()
        self._refresh_command_paths()
        await self._ensure_avahi()
        await self._ensure_bluealsa()
        await self._prepare_adapter()

        enabled_targets = [target for target in self.config.targets if target.enabled]
        if not enabled_targets:
            self.global_state = "idle"
            self._notify()
            return

        for target in enabled_targets:
            status = self._target_statuses[target.id]
            process = self._shairport_processes.get(target.id)
            audio_process = self._audio_processes.get(target.id)
            if (
                process
                and process.returncode is None
                and audio_process
                and audio_process.returncode is None
                and status.connected
                and status.bluealsa_ready
            ):
                status.update(
                    state="running",
                    airplay_ready=True,
                    shairport_pid=process.pid,
                    audio_pid=audio_process.pid,
                )
                continue

            await self._connect_target(target)
            if status.connected and status.bluealsa_ready:
                await self._ensure_shairport(target)
            else:
                await self._stop_shairport(target)

        self._update_global_state()
        self._notify()

    async def _ensure_avahi(self) -> None:
        if not self.command_paths.get("avahi-daemon"):
            self._record_dependency_error("avahi-daemon not found; AirPlay discovery may fail")
            return
        result = await self._run(["avahi-daemon", "--check"], timeout=5)
        if result[0] == 0:
            return
        await self._run(
            ["avahi-daemon", "--daemonize", "--no-drop-root", "--no-chroot"],
            timeout=5,
            allow_missing=True,
        )

    async def _ensure_bluealsa(self, force_restart: bool = False) -> None:
        if force_restart and self._bluealsa_process:
            await self._stop_process(self._bluealsa_process)
            self._bluealsa_process = None
        if self._bluealsa_process and self._bluealsa_process.returncode is None:
            return
        if not self.command_paths.get("bluealsa"):
            self._record_dependency_error("bluealsa not found; Bluetooth audio output cannot start")
            return
        command = await self._bluealsa_command()
        self._bluealsa_process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.sleep(0.5)
        if self._bluealsa_process.returncode is not None:
            self._bluealsa_process = None
            if not await self._bluealsa_service_available():
                self._record_dependency_error(
                    "bluealsa exited immediately; Bluetooth audio output cannot start"
                )

    async def _bluealsa_command(self) -> list[str]:
        """Return a BlueALSA command tuned for stable Echo A2DP playback."""
        command = [
            "bluealsa",
            "--profile=a2dp-source",
            f"--device={self.config.adapter}",
        ]
        optional_args = (
            ("--keep-alive", "--keep-alive=5"),
            ("--sbc-quality", "--sbc-quality=high"),
        )
        for marker, argument in optional_args:
            if await self._bluealsa_supports(marker):
                command.append(argument)
        if await self._bluealsa_supports("--codec") and "aac" in (
            self._bluealsa_help or ""
        ).lower():
            command.append("--codec=-aac")
        return command

    async def _bluealsa_supports(self, option: str) -> bool:
        """Return whether the installed BlueALSA exposes an optional argument."""
        if self._bluealsa_help is None:
            result = await self._run(["bluealsa", "--help"], timeout=5, allow_missing=True)
            self._bluealsa_help = result[1]
        return option in self._bluealsa_help

    async def _prepare_adapter(self) -> None:
        if not self._dbus_available():
            self._record_dependency_error("system D-Bus socket not available; Bluetooth cannot be controlled")
            return
        if not self.command_paths.get("bluetoothctl"):
            self._record_dependency_error("bluetoothctl not found; Bluetooth cannot be controlled")
            return
        await self._bluetooth_batch(
            [
                f"select {self.config.adapter}",
                "power on",
                "agent NoInputNoOutput",
                "default-agent",
            ],
            timeout=10,
        )

    async def _ensure_shairport(self, target: Target) -> None:
        process = self._shairport_processes.get(target.id)
        status = self._target_statuses[target.id]
        if not status.connected or not status.bluealsa_ready:
            await self._stop_shairport(target)
            status.update(
                state="warning",
                airplay_ready=False,
                shairport_pid=None,
                audio_pid=None,
                last_error="BlueALSA A2DP audio device is not ready",
            )
            return
        if process and process.returncode is None:
            audio_process = self._audio_processes.get(target.id)
            if audio_process and audio_process.returncode is None:
                status.update(
                    airplay_ready=True,
                    shairport_pid=process.pid,
                    audio_pid=audio_process.pid,
                )
                return
            await self._stop_shairport(target)
            process = None
        if not await self._ensure_audio_pipe_player(target):
            return
        if not self.command_paths.get("shairport-sync"):
            status.update(
                state="error",
                airplay_ready=False,
                shairport_pid=None,
                audio_pid=None,
                last_error="shairport-sync not found",
            )
            self._record_dependency_error("shairport-sync not found; AirPlay receivers cannot start")
            return

        command = [
            "shairport-sync",
            "-u",
        ]
        if self.config.log_level == "debug":
            command.append("-v")
        elif self.config.log_level == "trace":
            command.extend(("-v", "-v", "-v"))
        command.extend(("-c", str(self._config_path(target))))

        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._shairport_processes[target.id] = process
        if process.stdout is not None:
            self._shairport_log_tasks[target.id] = asyncio.create_task(
                self._capture_shairport_output(target.id, process.stdout)
            )
        await asyncio.sleep(1)
        if process.returncode is None:
            updates: dict[str, object] = {
                "airplay_ready": True,
                "shairport_pid": process.pid,
                "audio_pid": self._audio_processes[target.id].pid,
            }
            if status.connected:
                updates.update(state="running", last_error=None)
            else:
                updates.update(state="warning")
            status.update(
                **updates,
            )
        else:
            status.update(
                state="error",
                airplay_ready=False,
                shairport_pid=None,
                audio_pid=None,
                last_error=(
                    "shairport-sync exited immediately"
                    + self._format_recent_output_hint(status.recent_output)
                ),
            )
            await self._stop_target_audio(target)

    async def _stop_orphan_shairport_processes(self) -> None:
        if not shutil.which("pkill"):
            return
        for target in self.config.targets:
            pattern = re.escape(str(self._config_path(target)))
            await self._run(["pkill", "-f", pattern], timeout=5, allow_missing=True)

    async def _stop_orphan_audio_processes(self) -> None:
        has_pkill = shutil.which("pkill")
        for target in self.config.targets:
            pipe_path = self._audio_pipe_path(target)
            if has_pkill:
                pattern = re.escape(str(pipe_path))
                await self._run(["pkill", "-f", pattern], timeout=5, allow_missing=True)
            with contextlib.suppress(FileNotFoundError):
                pipe_path.unlink()

    async def _stop_orphan_bluealsa_processes(self) -> None:
        if not shutil.which("pkill"):
            return
        await self._run(["pkill", "-x", "bluealsa"], timeout=5, allow_missing=True)

    async def _ensure_audio_pipe_player(self, target: Target) -> bool:
        process = self._audio_processes.get(target.id)
        status = self._target_statuses[target.id]
        if process and process.returncode is None:
            status.update(audio_pid=process.pid)
            return True

        await self._stop_target_audio(target)
        if not self.command_paths.get("aplay") and not shutil.which("aplay"):
            status.update(
                state="error",
                airplay_ready=False,
                shairport_pid=None,
                audio_pid=None,
                last_error="aplay not found",
            )
            return False

        pipe_path = self._audio_pipe_path(target)
        pipe_path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(FileNotFoundError):
            pipe_path.unlink()
        os.mkfifo(pipe_path, 0o600)

        process = await asyncio.create_subprocess_exec(
            "aplay",
            "-q",
            "-D",
            bluealsa_device(target),
            "-f",
            "S16_LE",
            "-c",
            "2",
            "-r",
            "44100",
            "-t",
            "raw",
            str(pipe_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._audio_processes[target.id] = process
        if process.stdout is not None:
            self._audio_log_tasks[target.id] = asyncio.create_task(
                self._capture_audio_output(target.id, process.stdout)
            )

        await asyncio.sleep(0.2)
        if process.returncode is None:
            status.update(
                audio_pid=process.pid,
                last_message="Bluetooth audio pipe ready",
                last_error=None,
            )
            return True

        status.update(
            state="error",
            airplay_ready=False,
            shairport_pid=None,
            audio_pid=None,
            last_error=(
                "aplay audio pipe exited immediately"
                + self._format_recent_output_hint(status.recent_output)
            ),
        )
        await self._stop_target_audio(target)
        return False

    async def _stop_shairport(self, target: Target) -> None:
        process = self._shairport_processes.pop(target.id, None)
        if process is not None:
            await self._stop_process(process)
        task = self._shairport_log_tasks.pop(target.id, None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._stop_target_audio(target)
        self._target_statuses[target.id].update(
            airplay_ready=False,
            shairport_pid=None,
            audio_pid=None,
        )

    async def _stop_target_audio(self, target: Target) -> None:
        process = self._audio_processes.pop(target.id, None)
        if process is not None:
            await self._stop_process(process)
        task = self._audio_log_tasks.pop(target.id, None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        with contextlib.suppress(FileNotFoundError):
            self._audio_pipe_path(target).unlink()

    def _enabled_targets_for_action(self, target_id: str | None) -> list[Target]:
        targets = [
            target
            for target in self.config.targets
            if target.enabled and (target_id is None or target.id == str(target_id))
        ]
        if targets:
            return targets

        self.global_state = "warning"
        if target_id is None:
            self.global_error = "No enabled Alexa-Airplay targets configured"
        else:
            self.global_error = f"No enabled Alexa-Airplay target found for id {target_id}"
        return []

    async def _prepare_bluetooth_for_action(self, targets: list[Target]) -> bool:
        self._refresh_command_paths()
        if not self._dbus_available() or not self.command_paths.get("bluetoothctl"):
            message = "Bluetooth control is unavailable"
            self.global_state = "warning"
            self.global_error = message
            for target in targets:
                self._target_statuses[target.id].update(
                    connected=False,
                    bluealsa_ready=False,
                    state="warning",
                    last_message=None,
                    last_error=message,
                )
            return False

        try:
            await self._prepare_adapter()
        except (CommandUnavailableError, OSError, TimeoutError) as err:
            message = f"Bluetooth adapter setup failed: {err}"
            self.global_state = "warning"
            self.global_error = message
            for target in targets:
                self._target_statuses[target.id].update(
                    connected=False,
                    bluealsa_ready=False,
                    state="warning",
                    last_message=None,
                    last_error=message,
                )
            return False
        return True

    async def _run_target_action(
        self,
        target: Target,
        action_name: str,
        action: Callable[[Target], Awaitable[None]],
    ) -> None:
        try:
            await action(target)
        except (CommandUnavailableError, OSError, TimeoutError) as err:
            self._target_statuses[target.id].update(
                connected=False,
                bluealsa_ready=False,
                state="warning",
                last_message=None,
                last_error=f"{action_name} failed: {err}",
            )

    async def _reconnect_target(self, target: Target) -> None:
        await self._connect_target(target)
        if self._target_statuses[target.id].bluealsa_ready:
            await self._ensure_shairport(target)
        else:
            await self._stop_shairport(target)

    async def _connect_target(self, target: Target) -> None:
        status = self._target_statuses[target.id]
        if not self._dbus_available() or not self.command_paths.get("bluetoothctl"):
            status.update(
                connected=False,
                bluealsa_ready=False,
                last_error="Bluetooth control is unavailable",
            )
            return

        info = await self._bluetooth_info(target.mac)
        if "Paired: yes" not in info:
            status.update(
                connected=False,
                bluealsa_ready=False,
                state="warning",
                last_message=None,
                last_error=(
                    "Bluetooth target is not paired. Put the Echo in Bluetooth "
                    "pairing mode, then press Bluetooth pair in Home Assistant."
                ),
            )
            return

        await self._trust_target(target)
        info = await self._bluetooth_info(target.mac)
        if "Connected: yes" in info:
            await self._mark_target_connected(target)
            return

        result = await self._run(["bluetoothctl", "connect", target.mac], timeout=20)
        output = result[1]
        if (
            result[0] == 0
            or "Connection successful" in output
            or "AlreadyConnected" in output
            or "Already connected" in output
        ):
            await self._mark_target_connected(target)
            return

        if "br-connection-busy" in output:
            status.update(
                connected=True,
                bluealsa_ready=False,
                state="warning",
                last_message="Bluetooth may already be connected",
                last_error="Bluetooth busy; device may already be connected",
            )
            return

        status.update(
            connected=False,
            bluealsa_ready=False,
            state="warning",
            last_message=None,
            last_error=clean_command_output(output) or "Bluetooth connect failed",
        )

    async def _mark_target_connected(self, target: Target) -> None:
        status = self._target_statuses[target.id]
        status.update(
            connected=True,
            bluealsa_ready=False,
            state="warning",
            last_message="Bluetooth connected; waiting for BlueALSA audio",
            last_error=None,
        )
        bluealsa_ready, bluealsa_error = await self._wait_for_bluealsa_playback(target)
        if not bluealsa_ready and not status.bluealsa_recovery_attempted:
            status.bluealsa_recovery_attempted = True
            recovered = await self._recover_bluealsa_playback(target, bluealsa_error)
            if recovered:
                bluealsa_ready, bluealsa_error = await self._wait_for_bluealsa_playback(target)

        if not bluealsa_ready:
            status.update(
                connected=True,
                bluealsa_ready=False,
                state="warning",
                last_message="Bluetooth connected",
                last_error=(
                    "BlueALSA A2DP playback is not ready. The Echo is connected "
                    "over Bluetooth, but the ALSA playback device cannot be opened "
                    f"for AirPlay audio: {bluealsa_error or 'unknown error'}"
                ),
            )
            return

        status.update(
            connected=True,
            bluealsa_ready=True,
            bluealsa_recovery_attempted=False,
            state="running" if status.airplay_ready else "warning",
            last_message="Bluetooth audio ready",
            last_error=None,
        )

    async def _recover_bluealsa_playback(self, target: Target, reason: str | None) -> bool:
        status = self._target_statuses[target.id]
        status.update(
            connected=False,
            bluealsa_ready=False,
            state="warning",
            last_message="Restarting BlueALSA audio",
            last_error=(
                "BlueALSA playback was not ready"
                + self._format_recent_output_hint([reason or "unknown error"])
            ),
        )
        self._notify()

        await self._stop_shairport(target)
        await self._run(
            ["bluetoothctl", "disconnect", target.mac],
            timeout=10,
            allow_missing=True,
        )
        await self._stop_orphan_bluealsa_processes()
        await self._ensure_bluealsa(force_restart=True)
        await asyncio.sleep(1)

        result = await self._run(["bluetoothctl", "connect", target.mac], timeout=25)
        output = clean_command_output(result[1])
        if result[0] != 0 and not (
            "Connection successful" in result[1]
            or "AlreadyConnected" in result[1]
            or "Already connected" in result[1]
        ):
            status.update(
                connected=False,
                bluealsa_ready=False,
                state="warning",
                last_message=None,
                last_error=(
                    "Bluetooth reconnect after BlueALSA restart failed"
                    + self._format_recent_output_hint([output])
                ),
            )
            return False

        status.update(
            connected=True,
            bluealsa_ready=False,
            state="warning",
            last_message="Bluetooth reconnected; waiting for BlueALSA audio",
            last_error=None,
        )
        return True

    async def _wait_for_bluealsa_playback(self, target: Target) -> tuple[bool, str | None]:
        last_error: str | None = None
        for _ in range(5):
            ready, error = await self._bluealsa_playback_available(target)
            if ready:
                return True, None
            last_error = error
            await asyncio.sleep(1)
        return False, last_error

    async def _bluealsa_playback_available(self, target: Target) -> tuple[bool, str | None]:
        if not self.command_paths.get("aplay") and not shutil.which("aplay"):
            return False, "aplay not found"

        result = await self._run(
            [
                "aplay",
                "-q",
                "-D",
                bluealsa_device(target),
                "-f",
                "S16_LE",
                "-c",
                "2",
                "-r",
                "44100",
                "-t",
                "raw",
                "-d",
                "1",
                "/dev/zero",
            ],
            timeout=4,
            allow_missing=True,
        )
        output = clean_command_output(result[1])
        if result[0] == 0:
            return True, None
        return False, output or f"aplay exited with code {result[0]}"

    async def _bluealsa_service_available(self) -> bool:
        if not self.command_paths.get("bluealsa-aplay") and not shutil.which("bluealsa-aplay"):
            return False
        result = await self._run(
            ["bluealsa-aplay", "--list-pcms"],
            timeout=10,
            allow_missing=True,
        )
        return result[0] == 0

    async def _pair_target(self, target: Target) -> None:
        status = self._target_statuses[target.id]
        status.update(
            state="pairing",
            connected=False,
            bluealsa_ready=False,
            last_message="Pairing Bluetooth target",
            last_error=None,
        )
        self._notify()

        info = await self._bluetooth_info(target.mac)
        if "Paired: yes" not in info:
            await self._run(
                ["bluetoothctl", "disconnect", target.mac],
                timeout=10,
                allow_missing=True,
            )
            await self._run(
                ["bluetoothctl", "remove", target.mac],
                timeout=15,
                allow_missing=True,
            )
            await self._run(
                ["bluetoothctl", "--timeout", "8", "scan", "on"],
                timeout=12,
                allow_missing=True,
            )
            pair_result = await self._run(
                ["bluetoothctl", "pair", target.mac],
                timeout=60,
                allow_missing=True,
            )
            paired = await self._wait_until_paired(target)
        else:
            pair_result = (0, "Already paired")
            paired = True

        if not paired:
            status.update(
                connected=False,
                bluealsa_ready=False,
                state="warning",
                last_message=None,
                last_error=(
                    "Bluetooth pairing failed. Put the Echo in Bluetooth pairing "
                    "mode, then press Bluetooth pair"
                    + self._format_recent_output_hint([clean_command_output(pair_result[1])])
                ),
            )
            return

        await self._trust_target(target)
        status.update(
            state="paired",
            last_message="Bluetooth paired and trusted",
            last_error=None,
        )
        await self._connect_target(target)
        if status.bluealsa_ready:
            await self._ensure_shairport(target)
        else:
            await self._stop_shairport(target)

    async def _wait_until_paired(self, target: Target) -> bool:
        for _ in range(15):
            info = await self._bluetooth_info(target.mac)
            if "Paired: yes" in info:
                return True
            await asyncio.sleep(2)
        return False

    async def _trust_target(self, target: Target) -> None:
        result = await self._run(["bluetoothctl", "trust", target.mac], timeout=10)
        if result[0] != 0 and "trust succeeded" not in result[1].lower():
            self._target_statuses[target.id].update(
                state="warning",
                last_error=(
                    "Bluetooth trust failed"
                    + self._format_recent_output_hint([clean_command_output(result[1])])
                ),
            )

    async def _forget_target(self, target: Target) -> None:
        status = self._target_statuses[target.id]
        status.update(
            state="forgetting",
            connected=False,
            bluealsa_ready=False,
            last_message="Removing Bluetooth pairing",
            last_error=None,
        )
        self._notify()

        await self._run(
            ["bluetoothctl", "disconnect", target.mac],
            timeout=10,
            allow_missing=True,
        )
        result = await self._run(
            ["bluetoothctl", "remove", target.mac],
            timeout=15,
            allow_missing=True,
        )
        info = await self._bluetooth_info(target.mac)
        if "Paired: yes" in info or "Connected: yes" in info:
            status.update(
                connected=False,
                bluealsa_ready=False,
                state="warning",
                last_message=None,
                last_error=(
                    "Bluetooth pairing could not be removed"
                    + self._format_recent_output_hint([clean_command_output(result[1])])
                ),
            )
            return

        status.update(
            connected=False,
            bluealsa_ready=False,
            state="configured",
            last_message=(
                "Bluetooth pairing removed. Put the Echo in pairing mode, then "
                "press Bluetooth pair."
            ),
            last_error=None,
        )

    async def _bluetooth_info(self, mac: str) -> str:
        return (await self._run(["bluetoothctl", "info", mac], timeout=10))[1]

    async def _bluetooth_batch(self, commands: list[str], timeout: int) -> str:
        if not shutil.which("bluetoothctl"):
            raise CommandUnavailableError("bluetoothctl not found")
        process = await asyncio.create_subprocess_exec(
            "bluetoothctl",
            "--timeout",
            str(timeout),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(
            process.communicate(("\n".join(commands) + "\n").encode()),
            timeout=timeout + 5,
        )
        return stdout.decode(errors="replace")

    async def _run(
        self,
        command: list[str],
        timeout: int,
        allow_missing: bool = False,
    ) -> tuple[int, str]:
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError as err:
            if allow_missing:
                return 127, str(err)
            raise CommandUnavailableError(f"{command[0]} not found") from err

        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError:
            process.kill()
            stdout, _ = await process.communicate()
            return 124, stdout.decode(errors="replace")
        return process.returncode or 0, stdout.decode(errors="replace")

    async def _stop_process(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()

    async def _capture_shairport_output(
        self,
        target_id: str,
        stream: asyncio.StreamReader,
    ) -> None:
        status = self._target_statuses[target_id]
        while line := await stream.readline():
            text = line.decode(errors="replace").strip()
            if not text:
                continue
            status.recent_output.append(text[-800:])
            del status.recent_output[:-20]
            if any(marker in text.lower() for marker in BLUEALSA_PCM_MISSING_MARKERS):
                status.update(
                    bluealsa_ready=False,
                    last_message=None,
                    last_error="BlueALSA A2DP audio device is not ready",
                )
        await self._stop_target_audio(status.target)
        status.update(
            airplay_ready=False,
            shairport_pid=None,
            audio_pid=None,
            state="warning" if status.target.enabled else "disabled",
        )
        self._notify()

    async def _capture_audio_output(
        self,
        target_id: str,
        stream: asyncio.StreamReader,
    ) -> None:
        status = self._target_statuses[target_id]
        while line := await stream.readline():
            text = line.decode(errors="replace").strip()
            if not text:
                continue
            status.recent_output.append(text[-800:])
            del status.recent_output[:-20]
            lowered = text.lower()
            if "underrun" in lowered or any(
                marker in lowered for marker in BLUEALSA_PCM_MISSING_MARKERS
            ):
                status.update(
                    airplay_ready=False,
                    last_message=None,
                    last_error=text[-800:],
                )

        if target_id in self._audio_processes:
            self._audio_processes.pop(target_id, None)
            self._audio_log_tasks.pop(target_id, None)
            status.update(
                audio_pid=None,
                airplay_ready=False,
                state="warning" if status.target.enabled else "disabled",
                last_error=(
                    "aplay audio pipe exited"
                    + self._format_recent_output_hint(status.recent_output)
                ),
            )
            self._notify()

    @staticmethod
    def _format_recent_output_hint(lines: list[str]) -> str:
        if not lines:
            return ""
        return ": " + " | ".join(lines[-4:])

    def _record_dependency_error(self, message: str) -> None:
        if message not in self.dependency_errors:
            self.dependency_errors.append(message)

    def _refresh_command_paths(self) -> None:
        self.command_paths = {cmd: shutil.which(cmd) for cmd in ALL_REQUIRED_COMMANDS}

    def _missing_commands(self) -> list[str]:
        return [cmd for cmd in ALL_REQUIRED_COMMANDS if self.command_paths.get(cmd) is None]

    async def _maybe_auto_install_dependencies(self) -> None:
        missing = self._missing_commands()
        if not missing or self._auto_install_attempted:
            return

        self._auto_install_attempted = True
        if hasattr(os, "geteuid") and os.geteuid() != 0:
            self.auto_install_state = "skipped"
            self.auto_install_error = "Home Assistant is not running as root"
            return

        if shutil.which("apk"):
            command = ["apk", "add", "--no-cache", *APK_PACKAGES]
            manager = "apk"
        elif shutil.which("apt-get"):
            command = [
                "sh",
                "-c",
                "export DEBIAN_FRONTEND=noninteractive; "
                "apt-get update && apt-get install -y --no-install-recommends "
                + " ".join(APT_PACKAGES),
            ]
            manager = "apt-get"
        else:
            self.auto_install_state = "skipped"
            self.auto_install_error = "no supported package manager found inside Home Assistant"
            return

        self.auto_install_state = "running"
        self.auto_install_error = None
        return_code, output = await self._run(command, timeout=240, allow_missing=True)
        self.auto_install_output = output.splitlines()[-20:]

        if return_code != 0:
            self.auto_install_state = "failed"
            self.auto_install_error = f"{manager} exited with code {return_code}"
            return

        self.auto_install_state = "success"
        self.auto_install_error = None

    def _update_global_state(self) -> None:
        missing_airplay = [
            cmd for cmd in AIRPLAY_REQUIRED_COMMANDS if self.command_paths.get(cmd) is None
        ]
        if missing_airplay:
            self.global_state = "error"
            self.global_error = (
                "Missing AirPlay runtime command(s): " + ", ".join(missing_airplay)
            )
            return

        missing_discovery = [
            cmd for cmd in DISCOVERY_REQUIRED_COMMANDS if self.command_paths.get(cmd) is None
        ]
        if missing_discovery:
            self.global_state = "warning"
            self.global_error = (
                "Missing discovery command(s): "
                + ", ".join(missing_discovery)
                + "; AirPlay receivers may not appear on iPhone/Mac"
            )
            return

        warning_targets = [
            status.target.airplay_name
            for status in self._target_statuses.values()
            if status.target.enabled and status.state in {"warning", "error"}
        ]
        if warning_targets:
            self.global_state = "warning"
            self.global_error = "Targets need attention: " + ", ".join(warning_targets)
            return

        self.global_state = "running"
        self.global_error = None

    @staticmethod
    def _dbus_available() -> bool:
        return os.path.exists("/run/dbus/system_bus_socket") or os.path.exists(
            "/var/run/dbus/system_bus_socket"
        )
