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
from typing import Any, Callable

MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
LOG_LEVELS = {"trace", "debug", "info", "warning", "error"}
AIRPLAY_REQUIRED_COMMANDS = ("shairport-sync", "bluealsa")
DISCOVERY_REQUIRED_COMMANDS = ("avahi-daemon",)
BLUETOOTH_REQUIRED_COMMANDS = ("bluetoothctl", "bluealsa-aplay")


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
    airplay_ready: bool = False
    shairport_pid: int | None = None
    last_error: str | None = None
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def update(self, **changes: object) -> None:
        for key, value in changes.items():
            setattr(self, key, value)
        self.updated_at = datetime.now(timezone.utc).isoformat()


def normalize_mac(mac: object) -> str:
    """Normalize a Bluetooth MAC address."""
    return str(mac).strip().upper()


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


def render_shairport_config(target: Target) -> str:
    """Render shairport-sync config for one target."""
    return (
        "general = {\n"
        f'  name = "{escape_shairport_string(target.airplay_name)}";\n'
        '  output_backend = "alsa";\n'
        f"  port = {target.raop_port};\n"
        f"  udp_port_base = {target.udp_port_base};\n"
        "  udp_port_range = 10;\n"
        "};\n\n"
        "alsa = {\n"
        f'  output_device = "bluealsa:DEV={target.mac}";\n'
        '  mixer_control_name = "";\n'
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
        self._listeners: set[Callable[[], None]] = set()
        self._monitor_task: asyncio.Task | None = None
        self._bluealsa_process: asyncio.subprocess.Process | None = None
        self._shairport_processes: dict[str, asyncio.subprocess.Process] = {}
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
        self._write_configs()
        self.global_state = "running"
        self.global_error = None
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        self._notify()

    async def async_restart(self) -> None:
        await self.async_start()

    async def async_reconnect(self, target_id: str | None = None) -> None:
        for target in self.config.targets:
            if target_id is not None and target.id != str(target_id):
                continue
            if target.enabled:
                await self._connect_target(target)
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

        if self._bluealsa_process:
            await self._stop_process(self._bluealsa_process)
            self._bluealsa_process = None

    def diagnostics(self) -> dict[str, Any]:
        return {
            "global_state": self.global_state,
            "global_error": self.global_error,
            "dependency_errors": self.dependency_errors,
            "command_paths": self.command_paths,
            "runtime_advice": self.runtime_advice(),
            "targets": {
                target_id: {
                    "state": status.state,
                    "connected": status.connected,
                    "airplay_ready": status.airplay_ready,
                    "shairport_pid": status.shairport_pid,
                    "last_error": status.last_error,
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
            return None
        return (
            "Missing runtime commands inside Home Assistant: "
            f"{', '.join(missing)}. For Home Assistant Container, run the README "
            "requirements one-liner on the Docker host and restart the container."
        )

    def _write_configs(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        for old_config in self.runtime_dir.glob("target_*.shairport-sync.conf"):
            old_config.unlink()

        for target in self.config.targets:
            if not target.enabled:
                continue
            config_path = self._config_path(target)
            config_path.write_text(render_shairport_config(target), encoding="utf-8")
            self._target_statuses[target.id].update(state="configured", last_error=None)

    def _config_path(self, target: Target) -> Path:
        return self.runtime_dir / f"target_{target.id}.shairport-sync.conf"

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
        await self._ensure_avahi()
        await self._ensure_bluealsa()
        await self._prepare_adapter()

        enabled_targets = [target for target in self.config.targets if target.enabled]
        if not enabled_targets:
            self.global_state = "idle"
            self._notify()
            return

        for target in enabled_targets:
            await self._ensure_shairport(target)
            if self._target_statuses[target.id].airplay_ready:
                await self._connect_target(target)

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

    async def _ensure_bluealsa(self) -> None:
        if self._bluealsa_process and self._bluealsa_process.returncode is None:
            return
        if not self.command_paths.get("bluealsa"):
            self._record_dependency_error("bluealsa not found; Bluetooth audio output cannot start")
            return
        self._bluealsa_process = await asyncio.create_subprocess_exec(
            "bluealsa",
            "--profile=a2dp-source",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )

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
        if process and process.returncode is None:
            status.update(airplay_ready=True, shairport_pid=process.pid)
            return
        if not self.command_paths.get("shairport-sync"):
            status.update(
                state="error",
                airplay_ready=False,
                shairport_pid=None,
                last_error="shairport-sync not found",
            )
            self._record_dependency_error("shairport-sync not found; AirPlay receivers cannot start")
            return

        process = await asyncio.create_subprocess_exec(
            "shairport-sync",
            "-c",
            str(self._config_path(target)),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._shairport_processes[target.id] = process
        await asyncio.sleep(1)
        if process.returncode is None:
            status.update(
                state="running",
                airplay_ready=True,
                shairport_pid=process.pid,
                last_error=None,
            )
        else:
            status.update(
                state="error",
                airplay_ready=False,
                shairport_pid=None,
                last_error="shairport-sync exited immediately",
            )

    async def _connect_target(self, target: Target) -> None:
        status = self._target_statuses[target.id]
        if not self._dbus_available() or not self.command_paths.get("bluetoothctl"):
            status.update(connected=False, last_error="Bluetooth control is unavailable")
            return

        info = await self._bluetooth_info(target.mac)
        if "Paired: yes" not in info:
            await self._bluetooth_batch([f"pair {target.mac}"], timeout=35)

        await self._bluetooth_batch([f"trust {target.mac}"], timeout=10)
        info = await self._bluetooth_info(target.mac)
        if "Connected: yes" in info:
            status.update(connected=True, state="running", last_error=None)
            return

        result = await self._run(["bluetoothctl", "connect", target.mac], timeout=20)
        output = result[1]
        if (
            result[0] == 0
            or "Connection successful" in output
            or "AlreadyConnected" in output
            or "Already connected" in output
        ):
            status.update(connected=True, state="running", last_error=None)
            return

        if "br-connection-busy" in output:
            status.update(connected=True, state="warning", last_error="Bluetooth busy; device may already be connected")
            return

        status.update(connected=False, state="warning", last_error=output.strip() or "Bluetooth connect failed")

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

    def _record_dependency_error(self, message: str) -> None:
        if message not in self.dependency_errors:
            self.dependency_errors.append(message)

    def _refresh_command_paths(self) -> None:
        commands = (
            *AIRPLAY_REQUIRED_COMMANDS,
            *DISCOVERY_REQUIRED_COMMANDS,
            *BLUETOOTH_REQUIRED_COMMANDS,
        )
        self.command_paths = {cmd: shutil.which(cmd) for cmd in commands}

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
