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

DEFAULT_LOG_LEVEL = "info"
DEFAULT_ADAPTER = "hci0"
DEFAULT_RECONNECT_INTERVAL_SECONDS = 15
DEFAULT_AIRPLAY_PORT_BASE = 5500
DEFAULT_UDP_PORT_BASE = 20000
DEFAULT_TARGETS_JSON = "[]"

LOG_LEVELS = ("trace", "debug", "info", "warning", "error")

PLATFORMS = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.BUTTON]
