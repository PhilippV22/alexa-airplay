"""Button entities for AirBridge."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .runtime import AirBridgeManager


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up AirBridge buttons."""
    manager: AirBridgeManager = hass.data[DOMAIN][entry.entry_id]
    entities: list[ButtonEntity] = [AirBridgeRestartButton(manager)]
    entities.extend(AirBridgeReconnectButton(manager, target_id) for target_id in manager.target_ids)
    async_add_entities(entities)


class AirBridgeRestartButton(ButtonEntity):
    """Restart all AirBridge processes."""

    _attr_has_entity_name = True
    _attr_name = "Restart"
    _attr_unique_id = "airbridge_restart"

    def __init__(self, manager: AirBridgeManager) -> None:
        self._manager = manager

    async def async_press(self) -> None:
        await self._manager.async_restart()


class AirBridgeReconnectButton(ButtonEntity):
    """Reconnect one AirBridge target."""

    _attr_has_entity_name = True

    def __init__(self, manager: AirBridgeManager, target_id: str) -> None:
        self._manager = manager
        self._target_id = target_id
        target = manager.target(target_id)
        self._attr_unique_id = f"airbridge_{target_id}_reconnect"
        self._attr_name = f"{target.airplay_name} reconnect"

    async def async_press(self) -> None:
        await self._manager.async_reconnect(self._target_id)
