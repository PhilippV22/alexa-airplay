"""Constants for AirBridge."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "airbridge"
NAME = "AirBridge"

CONF_LOG_LEVEL = "log_level"
CONF_ADAPTER = "adapter"
CONF_RECONNECT_INTERVAL_SECONDS = "reconnect_interval_seconds"
CONF_AIRPLAY_PORT_BASE = "airplay_port_base"
CONF_UDP_PORT_BASE = "udp_port_base"
CONF_TARGETS = "targets"
CONF_TARGETS_JSON = "targets_json"
CONF_KNOWN_DEVICE = "known_device"
CONF_MANUAL_MAC = "manual_mac"
CONF_TARGET_NAME = "target_name"
CONF_AIRPLAY_NAME = "airplay_name"
CONF_ENABLED = "enabled"
CONF_ADD_ANOTHER = "add_another"
CONF_FINISH_WITHOUT_TARGET = "finish_without_target"

DEFAULT_LOG_LEVEL = "info"
DEFAULT_ADAPTER = "hci0"
DEFAULT_RECONNECT_INTERVAL_SECONDS = 15
DEFAULT_AIRPLAY_PORT_BASE = 5500
DEFAULT_UDP_PORT_BASE = 20000
DEFAULT_TARGETS_JSON = "[]"

LOG_LEVELS = ("trace", "debug", "info", "warning", "error")

PLATFORMS = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.BUTTON]
