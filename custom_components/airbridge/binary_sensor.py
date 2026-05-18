"""Binary sensor entities for AirBridge."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
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
    """Set up AirBridge binary sensors."""
    manager: AirBridgeManager = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        AirBridgeTargetConnectedBinarySensor(manager, target_id)
        for target_id in manager.target_ids
    )


class AirBridgeTargetConnectedBinarySensor(BinarySensorEntity):
    """Connectivity sensor for one AirBridge target."""

    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_has_entity_name = True

    def __init__(self, manager: AirBridgeManager, target_id: str) -> None:
        self._manager = manager
        self._target_id = target_id
        target = manager.target(target_id)
        self._attr_unique_id = f"airbridge_{target_id}_connected"
        self._attr_name = f"{target.airplay_name} connected"

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._manager.async_add_listener(self.async_write_ha_state))

    @property
    def is_on(self) -> bool:
        return self._manager.target_status(self._target_id).connected

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        status = self._manager.target_status(self._target_id)
        return {
            "mac": status.target.mac,
            "state": status.state,
            "last_error": status.last_error,
        }
