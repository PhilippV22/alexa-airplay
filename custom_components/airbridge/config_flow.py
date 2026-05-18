"""Config flow for AirBridge."""

from __future__ import annotations

import json
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import (
    CONF_ADAPTER,
    CONF_AIRPLAY_PORT_BASE,
    CONF_LOG_LEVEL,
    CONF_RECONNECT_INTERVAL_SECONDS,
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
from .runtime import RuntimeConfigError, build_config


def _targets_to_json(data: dict[str, Any]) -> str:
    return json.dumps(data.get(CONF_TARGETS, []), indent=2)


def _normalize_input(user_input: dict[str, Any]) -> dict[str, Any]:
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


def _schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
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
            vol.Required(
                CONF_TARGETS_JSON,
                default=defaults.get(CONF_TARGETS_JSON, DEFAULT_TARGETS_JSON),
            ): str,
        }
    )


class AirBridgeConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle an AirBridge config flow."""

    VERSION = 1

    def __init__(self) -> None:
        self._last_error = ""

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                data = _normalize_input(user_input)
            except (RuntimeConfigError, ValueError) as err:
                errors["base"] = "invalid_config"
                self._last_error = str(err)
            else:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="AirBridge", data=data)

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(),
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

    async def async_step_init(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        errors: dict[str, str] = {}
        current = {**self._config_entry.data, **self._config_entry.options}

        if user_input is not None:
            try:
                data = _normalize_input(user_input)
            except (RuntimeConfigError, ValueError) as err:
                errors["base"] = "invalid_config"
                self._last_error = str(err)
            else:
                return self.async_create_entry(title="", data=data)

        defaults = {**current, CONF_TARGETS_JSON: _targets_to_json(current)}
        return self.async_show_form(
            step_id="init",
            data_schema=_schema(defaults),
            errors=errors,
            description_placeholders={"error": self._last_error},
        )
