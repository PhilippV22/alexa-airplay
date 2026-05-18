"""Sensor entities for AirBridge."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
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
    """Set up AirBridge sensors."""
    manager: AirBridgeManager = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = [AirBridgeRuntimeSensor(manager)]
    entities.extend(AirBridgeTargetStatusSensor(manager, target_id) for target_id in manager.target_ids)
    async_add_entities(entities)


class AirBridgeRuntimeSensor(SensorEntity):
    """Overall AirBridge runtime status."""

    _attr_has_entity_name = True
    _attr_name = "Runtime"
    _attr_unique_id = "airbridge_runtime"

    def __init__(self, manager: AirBridgeManager) -> None:
        self._manager = manager

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._manager.async_add_listener(self.async_write_ha_state))

    @property
    def native_value(self) -> str:
        return self._manager.global_state

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        return {
            "global_error": self._manager.global_error,
            "dependency_errors": self._manager.dependency_errors,
            "command_paths": self._manager.command_paths,
            "runtime_advice": self._manager.runtime_advice(),
            "target_count": len(self._manager.target_ids),
        }


class AirBridgeTargetStatusSensor(SensorEntity):
    """Status sensor for one AirBridge target."""

    _attr_has_entity_name = True

    def __init__(self, manager: AirBridgeManager, target_id: str) -> None:
        self._manager = manager
        self._target_id = target_id
        target = manager.target(target_id)
        self._attr_unique_id = f"airbridge_{target_id}_status"
        self._attr_name = f"{target.airplay_name} status"

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._manager.async_add_listener(self.async_write_ha_state))

    @property
    def native_value(self) -> str:
        return self._manager.target_status(self._target_id).state

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        status = self._manager.target_status(self._target_id)
        return {
            "name": status.target.name,
            "airplay_name": status.target.airplay_name,
            "mac": status.target.mac,
            "enabled": status.target.enabled,
            "connected": status.connected,
            "airplay_ready": status.airplay_ready,
            "shairport_pid": status.shairport_pid,
            "last_error": status.last_error,
            "recent_output": status.recent_output[-10:],
            "updated_at": status.updated_at,
        }
