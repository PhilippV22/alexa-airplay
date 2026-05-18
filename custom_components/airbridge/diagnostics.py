"""Diagnostics support for AirBridge."""

from __future__ import annotations

from copy import deepcopy

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_TARGETS, DOMAIN


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant,
    entry: ConfigEntry,
) -> dict:
    """Return diagnostics for an AirBridge config entry."""
    data = deepcopy({**entry.data, **entry.options})
    for target in data.get(CONF_TARGETS, []):
        if "mac" in target:
            target["mac"] = "**REDACTED**"

    manager = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    return {
        "config": data,
        "runtime": manager.diagnostics() if manager else None,
    }
