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
    for target_id in manager.target_ids:
        entities.extend(
            (
                AirBridgePairButton(manager, target_id),
                AirBridgeReconnectButton(manager, target_id),
                AirBridgeForgetButton(manager, target_id),
            )
        )
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


class AirBridgeTargetButton(ButtonEntity):
    """Base class for one AirBridge target action."""

    _attr_has_entity_name = True
    action_name = ""
    unique_suffix = ""

    def __init__(self, manager: AirBridgeManager, target_id: str) -> None:
        self._manager = manager
        self._target_id = target_id
        target = manager.target(target_id)
        self._attr_unique_id = f"airbridge_{target_id}_{self.unique_suffix}"
        self._attr_name = f"{target.airplay_name} {self.action_name}"

    @property
    def available(self) -> bool:
        return self._manager.target(self._target_id).enabled


class AirBridgePairButton(AirBridgeTargetButton):
    """Pair, trust and connect one AirBridge target."""

    action_name = "Bluetooth pair"
    unique_suffix = "pair"

    async def async_press(self) -> None:
        await self._manager.async_pair(self._target_id)


class AirBridgeReconnectButton(AirBridgeTargetButton):
    """Reconnect one AirBridge target."""

    action_name = "reconnect"
    unique_suffix = "reconnect"

    async def async_press(self) -> None:
        await self._manager.async_reconnect(self._target_id)


class AirBridgeForgetButton(AirBridgeTargetButton):
    """Remove the Bluetooth pairing for one AirBridge target."""

    action_name = "Bluetooth forget"
    unique_suffix = "forget"

    async def async_press(self) -> None:
        await self._manager.async_forget(self._target_id)
