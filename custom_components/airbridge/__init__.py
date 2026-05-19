"""AirBridge integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryError

from .const import DOMAIN, PLATFORMS
from .runtime import AirBridgeManager, RuntimeConfigError


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up global AirBridge services."""

    async def handle_restart(call: ServiceCall) -> None:
        for manager in hass.data.get(DOMAIN, {}).values():
            await manager.async_restart()

    async def handle_reconnect(call: ServiceCall) -> None:
        target_id = call.data.get("target_id")
        for manager in hass.data.get(DOMAIN, {}).values():
            await manager.async_reconnect(target_id)

    async def handle_pair(call: ServiceCall) -> None:
        target_id = call.data.get("target_id")
        for manager in hass.data.get(DOMAIN, {}).values():
            await manager.async_pair(target_id)

    async def handle_forget(call: ServiceCall) -> None:
        target_id = call.data.get("target_id")
        for manager in hass.data.get(DOMAIN, {}).values():
            await manager.async_forget(target_id)

    hass.services.async_register(DOMAIN, "restart", handle_restart)
    hass.services.async_register(DOMAIN, "reconnect", handle_reconnect)
    hass.services.async_register(DOMAIN, "pair", handle_pair)
    hass.services.async_register(DOMAIN, "forget", handle_forget)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up AirBridge from a config entry."""
    data = {**entry.data, **entry.options}
    runtime_dir = hass.config.path("airbridge")
    manager = AirBridgeManager(runtime_dir, data)

    try:
        await manager.async_start()
    except RuntimeConfigError as err:
        raise ConfigEntryError(str(err)) from err

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = manager
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload an AirBridge config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        manager = hass.data[DOMAIN].pop(entry.entry_id)
        await manager.async_stop()
        if not hass.data[DOMAIN]:
            hass.data.pop(DOMAIN)
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload AirBridge when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


def entry_title(data: dict) -> str:
    """Return a stable entry title."""
    return str(data.get(CONF_NAME) or "Alexa-Airplay")
