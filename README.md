# AirBridge

AirBridge is a HACS-installable Home Assistant custom integration that starts
one AirPlay receiver per configured Echo and forwards audio to that Echo over
Bluetooth A2DP.

## Install

1. Open HACS.
2. Add this repository as a custom repository.
3. Select category `Integration`.
4. Download `AirBridge`.
5. Restart Home Assistant.
6. Add the integration from `Settings` -> `Devices & services` -> `Add Integration`.

HACS installs files into `custom_components/airbridge`. It cannot install OS
packages. The integration therefore expects these commands to already be
available in the Home Assistant runtime:

- `shairport-sync`
- `bluealsa`
- `bluealsa-aplay`
- `bluetoothctl`
- optional: `avahi-daemon` for AirPlay discovery

## Configure

The setup flow asks for a JSON target list:

```json
[
  {
    "name": "Wohnzimmer Echo",
    "airplay_name": "AirBridge Wohnzimmer",
    "mac": "AA:BB:CC:DD:EE:FF",
    "enabled": true
  }
]
```

Put the Echo into Bluetooth pairing mode once before the first start. After
that, AirBridge tries to trust and reconnect the device automatically.

## How it works

For every enabled target, AirBridge writes a `shairport-sync` config under
`/config/airbridge`, starts `shairport-sync`, starts BlueALSA as an A2DP source,
and uses `bluetoothctl` to pair, trust and reconnect the Echo.

If the Home Assistant runtime cannot access Bluetooth, D-Bus or the required
commands, the integration still loads and exposes the problem as entity state
and attributes.

## Validate Locally

```bash
scripts/test.sh
```
