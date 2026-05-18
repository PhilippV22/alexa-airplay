"""Config flow for AirBridge."""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import shutil
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import (
    CONF_ADAPTER,
    CONF_AIRPLAY_PORT_BASE,
    CONF_AIRPLAY_NAME,
    CONF_ADD_ANOTHER,
    CONF_LOG_LEVEL,
    CONF_ENABLED,
    CONF_FINISH_WITHOUT_TARGET,
    CONF_KNOWN_DEVICE,
    CONF_MANUAL_MAC,
    CONF_RECONNECT_INTERVAL_SECONDS,
    CONF_TARGET_NAME,
    CONF_TARGETS,
    CONF_TARGETS_JSON,
    CONF_UDP_PORT_BASE,
    DEFAULT_ADAPTER,
    DEFAULT_AIRPLAY_PORT_BASE,
    DEFAULT_LOG_LEVEL,
    DEFAULT_RECONNECT_INTERVAL_SECONDS,
    DEFAULT_TARGETS_JSON,
    DEFAULT_UDP_PORT_BASE,
    DOMAIN,
    LOG_LEVELS,
)
from .runtime import RuntimeConfigError, build_config, normalize_mac

MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
NO_KNOWN_DEVICE = "__manual__"


def _targets_to_json(data: dict[str, Any]) -> str:
    return json.dumps(data.get(CONF_TARGETS, []), indent=2)


def _normalize_advanced_input(user_input: dict[str, Any]) -> dict[str, Any]:
    targets_raw = user_input.get(CONF_TARGETS_JSON, DEFAULT_TARGETS_JSON)
    try:
        targets = json.loads(targets_raw)
    except json.JSONDecodeError as err:
        raise RuntimeConfigError(f"targets_json is not valid JSON: {err.msg}") from err

    data = {
        CONF_LOG_LEVEL: user_input.get(CONF_LOG_LEVEL, DEFAULT_LOG_LEVEL),
        CONF_ADAPTER: str(user_input.get(CONF_ADAPTER, DEFAULT_ADAPTER)).strip(),
        CONF_RECONNECT_INTERVAL_SECONDS: int(
            user_input.get(CONF_RECONNECT_INTERVAL_SECONDS, DEFAULT_RECONNECT_INTERVAL_SECONDS)
        ),
        CONF_AIRPLAY_PORT_BASE: int(
            user_input.get(CONF_AIRPLAY_PORT_BASE, DEFAULT_AIRPLAY_PORT_BASE)
        ),
        CONF_UDP_PORT_BASE: int(user_input.get(CONF_UDP_PORT_BASE, DEFAULT_UDP_PORT_BASE)),
        CONF_TARGETS: targets,
    }
    build_config(data)
    return data


def _settings_from_input(user_input: dict[str, Any]) -> dict[str, Any]:
    data = {
        CONF_LOG_LEVEL: user_input.get(CONF_LOG_LEVEL, DEFAULT_LOG_LEVEL),
        CONF_ADAPTER: str(user_input.get(CONF_ADAPTER, DEFAULT_ADAPTER)).strip(),
        CONF_RECONNECT_INTERVAL_SECONDS: int(
            user_input.get(CONF_RECONNECT_INTERVAL_SECONDS, DEFAULT_RECONNECT_INTERVAL_SECONDS)
        ),
        CONF_AIRPLAY_PORT_BASE: int(
            user_input.get(CONF_AIRPLAY_PORT_BASE, DEFAULT_AIRPLAY_PORT_BASE)
        ),
        CONF_UDP_PORT_BASE: int(user_input.get(CONF_UDP_PORT_BASE, DEFAULT_UDP_PORT_BASE)),
    }
    build_config({**data, CONF_TARGETS: []})
    return data


def _settings_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    return vol.Schema(
        {
            vol.Required(
                CONF_LOG_LEVEL,
                default=defaults.get(CONF_LOG_LEVEL, DEFAULT_LOG_LEVEL),
            ): vol.In(LOG_LEVELS),
            vol.Required(
                CONF_ADAPTER,
                default=defaults.get(CONF_ADAPTER, DEFAULT_ADAPTER),
            ): str,
            vol.Required(
                CONF_RECONNECT_INTERVAL_SECONDS,
                default=defaults.get(
                    CONF_RECONNECT_INTERVAL_SECONDS,
                    DEFAULT_RECONNECT_INTERVAL_SECONDS,
                ),
            ): int,
            vol.Required(
                CONF_AIRPLAY_PORT_BASE,
                default=defaults.get(CONF_AIRPLAY_PORT_BASE, DEFAULT_AIRPLAY_PORT_BASE),
            ): int,
            vol.Required(
                CONF_UDP_PORT_BASE,
                default=defaults.get(CONF_UDP_PORT_BASE, DEFAULT_UDP_PORT_BASE),
            ): int,
        }
    )


def _advanced_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    schema = dict(_settings_schema(defaults).schema)
    schema.update(
        {
            vol.Required(
                CONF_TARGETS_JSON,
                default=defaults.get(CONF_TARGETS_JSON, DEFAULT_TARGETS_JSON),
            ): str,
            vol.Optional(CONF_ADD_ANOTHER, default=False): bool,
        }
    )
    return vol.Schema(schema)


def _target_schema(devices: dict[str, str]) -> vol.Schema:
    schema: dict[Any, Any] = {}
    choices = {NO_KNOWN_DEVICE: "Manual MAC"}
    choices.update(devices)

    schema[vol.Optional(CONF_KNOWN_DEVICE, default=next(iter(choices)))] = vol.In(choices)
    schema[vol.Optional(CONF_MANUAL_MAC, default="")] = str
    schema[vol.Required(CONF_TARGET_NAME, default="Echo")] = str
    schema[vol.Required(CONF_AIRPLAY_NAME, default="AirBridge Echo")] = str
    schema[vol.Optional(CONF_ENABLED, default=True)] = bool
    schema[vol.Optional(CONF_ADD_ANOTHER, default=False)] = bool
    schema[vol.Optional(CONF_FINISH_WITHOUT_TARGET, default=False)] = bool
    return vol.Schema(schema)


async def _discover_bluetooth_devices() -> dict[str, str]:
    if not shutil.which("bluetoothctl"):
        return {}

    with contextlib.suppress(FileNotFoundError, TimeoutError, OSError):
        scan = await asyncio.create_subprocess_exec(
            "bluetoothctl",
            "--timeout",
            "5",
            "scan",
            "on",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(scan.communicate(), timeout=8)

    try:
        process = await asyncio.create_subprocess_exec(
            "bluetoothctl",
            "devices",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=5)
    except (FileNotFoundError, TimeoutError, OSError):
        return {}

    devices: dict[str, str] = {}
    for line in stdout.decode(errors="replace").splitlines():
        parts = line.strip().split(" ", 2)
        if len(parts) < 2 or parts[0] != "Device":
            continue
        mac = normalize_mac(parts[1])
        if not MAC_RE.match(mac):
            continue
        name = parts[2].strip() if len(parts) == 3 else mac
        devices[mac] = f"{name} ({mac})"
    return devices


def _target_from_input(user_input: dict[str, Any]) -> dict[str, Any] | None:
    if user_input.get(CONF_FINISH_WITHOUT_TARGET):
        return None

    manual_mac = normalize_mac(user_input.get(CONF_MANUAL_MAC, ""))
    known_device = str(user_input.get(CONF_KNOWN_DEVICE, NO_KNOWN_DEVICE))
    mac = manual_mac or (known_device if known_device != NO_KNOWN_DEVICE else "")

    if not MAC_RE.match(mac):
        raise RuntimeConfigError("Choose a known Bluetooth device or enter a valid MAC address")

    name = str(user_input.get(CONF_TARGET_NAME, "")).strip()
    airplay_name = str(user_input.get(CONF_AIRPLAY_NAME, "")).strip()
    if not name:
        raise RuntimeConfigError("Target name is required")
    if not airplay_name:
        raise RuntimeConfigError("AirPlay name is required")

    return {
        "name": name,
        "airplay_name": airplay_name,
        "mac": mac,
        "enabled": bool(user_input.get(CONF_ENABLED, True)),
    }


def _validate_data(settings: dict[str, Any], targets: list[dict[str, Any]]) -> dict[str, Any]:
    data = {**settings, CONF_TARGETS: targets}
    build_config(data)
    return data


class AirBridgeConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle an AirBridge config flow."""

    VERSION = 1

    def __init__(self) -> None:
        self._last_error = ""
        self._settings: dict[str, Any] = {}
        self._targets: list[dict[str, Any]] = []

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                self._settings = _settings_from_input(user_input)
            except (RuntimeConfigError, ValueError) as err:
                errors["base"] = "invalid_config"
                self._last_error = str(err)
            else:
                return await self.async_step_target()

        return self.async_show_form(
            step_id="user",
            data_schema=_settings_schema(),
            errors=errors,
            description_placeholders={"error": self._last_error},
        )

    async def async_step_target(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Add one target with a guided form."""
        errors: dict[str, str] = {}
        devices = await _discover_bluetooth_devices()

        if user_input is not None:
            try:
                target = _target_from_input(user_input)
                if target is not None:
                    self._targets.append(target)
                data = _validate_data(self._settings, self._targets)
            except (RuntimeConfigError, ValueError) as err:
                errors["base"] = "invalid_config"
                self._last_error = str(err)
            else:
                if target is not None and user_input.get(CONF_ADD_ANOTHER):
                    self._last_error = ""
                    return await self.async_step_target()
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="AirBridge", data=data)

        return self.async_show_form(
            step_id="target",
            data_schema=_target_schema(devices),
            errors=errors,
            description_placeholders={"error": self._last_error},
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        return AirBridgeOptionsFlow(config_entry)


class AirBridgeOptionsFlow(config_entries.OptionsFlow):
    """Handle AirBridge options."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._config_entry = config_entry
        self._last_error = ""
        self._settings: dict[str, Any] = {}
        self._targets: list[dict[str, Any]] = []

    async def async_step_init(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        errors: dict[str, str] = {}
        current = {**self._config_entry.data, **self._config_entry.options}

        if user_input is not None:
            try:
                data = _normalize_advanced_input(user_input)
            except (RuntimeConfigError, ValueError) as err:
                errors["base"] = "invalid_config"
                self._last_error = str(err)
            else:
                if user_input.get(CONF_ADD_ANOTHER):
                    self._settings = {
                        key: data[key]
                        for key in (
                            CONF_LOG_LEVEL,
                            CONF_ADAPTER,
                            CONF_RECONNECT_INTERVAL_SECONDS,
                            CONF_AIRPLAY_PORT_BASE,
                            CONF_UDP_PORT_BASE,
                        )
                    }
                    self._targets = list(data[CONF_TARGETS])
                    return await self.async_step_target()
                return self.async_create_entry(title="", data=data)

        defaults = {**current, CONF_TARGETS_JSON: _targets_to_json(current)}
        return self.async_show_form(
            step_id="init",
            data_schema=_advanced_schema(defaults),
            errors=errors,
            description_placeholders={"error": self._last_error},
        )

    async def async_step_target(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Add one target from the options flow."""
        errors: dict[str, str] = {}
        devices = await _discover_bluetooth_devices()

        if user_input is not None:
            try:
                target = _target_from_input(user_input)
                if target is not None:
                    self._targets.append(target)
                data = _validate_data(self._settings, self._targets)
            except (RuntimeConfigError, ValueError) as err:
                errors["base"] = "invalid_config"
                self._last_error = str(err)
            else:
                if target is not None and user_input.get(CONF_ADD_ANOTHER):
                    self._last_error = ""
                    return await self.async_step_target()
                return self.async_create_entry(title="", data=data)

        return self.async_show_form(
            step_id="target",
            data_schema=_target_schema(devices),
            errors=errors,
            description_placeholders={"error": self._last_error},
        )
