#!/usr/bin/env python3
"""Pure runtime validation tests for Alexa-Airplay."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PATH = ROOT / "custom_components" / "airbridge" / "runtime.py"

spec = importlib.util.spec_from_file_location("airbridge_runtime", RUNTIME_PATH)
runtime = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules["airbridge_runtime"] = runtime
spec.loader.exec_module(runtime)


def base_options(targets):
    return {
        "log_level": "info",
        "adapter": "hci0",
        "reconnect_interval_seconds": 15,
        "airplay_port_base": 5500,
        "udp_port_base": 20000,
        "targets": targets,
    }


config = runtime.build_config(
    base_options(
        [
            {
                "name": "Wohnzimmer Echo",
                "airplay_name": "Alexa-Airplay Wohnzimmer",
                "mac": "aa:bb:cc:dd:ee:ff",
                "enabled": True,
            }
        ]
    )
)
assert config.targets[0].mac == "AA:BB:CC:DD:EE:FF"
assert config.targets[0].raop_port == 5500
assert config.targets[0].udp_port_base == 20000

rendered = runtime.render_shairport_config(config.targets[0])
assert 'name = "Alexa-Airplay Wohnzimmer";' in rendered
assert 'output_device = "bluealsa:DEV=AA:BB:CC:DD:EE:FF";' in rendered

manager = runtime.AirBridgeManager(
    str(ROOT / ".tmp-airbridge-test"),
    base_options(
        [
            {
                "name": "Wohnzimmer Echo",
                "airplay_name": "Alexa-Airplay Wohnzimmer",
                "mac": "aa:bb:cc:dd:ee:ff",
                "enabled": True,
            }
        ]
    ),
)
manager.command_paths = {cmd: "/usr/bin/true" for cmd in runtime.ALL_REQUIRED_COMMANDS}
manager.target_status("0").update(
    state="warning",
    connected=False,
    last_error=(
        "hci0 AA:BB:CC:DD:EE:FF type BR/EDR connect failed "
        "(status 0x0b, Rejected)"
    ),
)
assert "refusing the Bluetooth connection" in (manager.runtime_advice() or "")

manager.target_status("0").update(
    state="warning",
    connected=False,
    bluealsa_ready=False,
    last_error="Bluetooth pairing failed. Put the Echo in Bluetooth pairing mode",
)
assert "pairing did not complete" in (manager.runtime_advice() or "")

manager.target_status("0").update(
    state="warning",
    connected=True,
    bluealsa_ready=False,
    last_error="BlueALSA A2DP audio device is not ready",
)
assert "cannot open the A2DP playback output" in (manager.runtime_advice() or "")

redacted = runtime.redact_mac_addresses(
    {"error": "Failed to connect AA:BB:CC:DD:EE:FF", "items": ["aa:bb:cc:dd:ee:01"]}
)
assert redacted == {
    "error": "Failed to connect **REDACTED**",
    "items": ["**REDACTED**"],
}

empty = runtime.build_config(base_options([]))
assert empty.targets == ()

try:
    runtime.build_config(
        base_options(
            [
                {
                    "name": "Bad",
                    "airplay_name": "Alexa-Airplay Bad",
                    "mac": "not-a-mac",
                    "enabled": True,
                }
            ]
        )
    )
except runtime.RuntimeConfigError:
    pass
else:
    raise AssertionError("invalid MAC should fail")

try:
    runtime.build_config(
        base_options(
            [
                {
                    "name": "One",
                    "airplay_name": "Alexa-Airplay Same",
                    "mac": "AA:BB:CC:DD:EE:01",
                    "enabled": True,
                },
                {
                    "name": "Two",
                    "airplay_name": "Alexa-Airplay Same",
                    "mac": "AA:BB:CC:DD:EE:02",
                    "enabled": True,
                },
            ]
        )
    )
except runtime.RuntimeConfigError:
    pass
else:
    raise AssertionError("duplicate AirPlay name should fail")

print("runtime validation tests passed")
