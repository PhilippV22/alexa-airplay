# Alexa-Airplay

<p align="center">
  <img src="custom_components/airbridge/brand/logo.png" alt="Alexa-Airplay logo" width="320">
</p>

Alexa-Airplay is a HACS-installable Home Assistant custom integration that starts
one AirPlay receiver per configured Echo and forwards audio to that Echo over
Bluetooth A2DP.

## Install

1. Open HACS.
2. Add this repository as a custom repository.
3. Select category `Integration`.
4. Download `Alexa-Airplay`.
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

### Requirements one-liner

Run this on the Home Assistant host:

```bash
curl -fsSL https://raw.githubusercontent.com/PhilippV22/alexa-airplay/main/scripts/install-requirements-debian.sh | sudo bash
```

This installs `shairport-sync`, BlueZ, BlueALSA, Avahi, ALSA utilities and D-Bus,
then enables the relevant systemd services.

For Home Assistant Container, the same one-liner also tries to detect the
running Home Assistant container and install the missing commands inside it.
If your container has a custom name, pass it explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/PhilippV22/alexa-airplay/main/scripts/install-requirements-debian.sh | sudo AIRBRIDGE_HA_CONTAINER=homeassistant bash
```

AirPlay discovery needs the Home Assistant container to use host networking.
Bluetooth control also needs the host D-Bus socket mounted into the container,
usually `/run/dbus:/run/dbus:ro`.

## Configure

The setup flow is guided:

1. Set runtime defaults like Bluetooth adapter and AirPlay base ports.
2. Put the Echo in Bluetooth pairing mode.
3. Add an Echo target by choosing a detected Bluetooth device from the dropdown, or paste the Echo Bluetooth MAC manually.
4. Set the AirPlay name that should appear on iPhone, iPad or Mac.
5. Optionally add more targets.

Advanced editing is still available in the integration options as Targets JSON:

```json
[
  {
    "name": "Wohnzimmer Echo",
    "airplay_name": "Alexa-Airplay Wohnzimmer",
    "mac": "AA:BB:CC:DD:EE:FF",
    "enabled": true
  }
]
```

Put the Echo into Bluetooth pairing mode once before the first start. After
that, Alexa-Airplay tries to trust and reconnect the device automatically.

## How it works

For every enabled target, Alexa-Airplay writes a `shairport-sync` config under
`/config/airbridge`, starts `shairport-sync`, starts BlueALSA as an A2DP source,
and uses `bluetoothctl` to pair, trust and reconnect the Echo.

If the Home Assistant runtime cannot access Bluetooth, D-Bus or the required
commands, the integration still loads and exposes the problem as entity state
and attributes.

If no AirPlay receiver appears on iPhone or Mac, check the `Runtime` sensor
attributes first. `shairport-sync` and `avahi-daemon` must be present inside
the Home Assistant runtime, not only on the Docker host.

If you only see an old AirPlay receiver named `server`, that is usually the
package default `shairport-sync` service on the host. Re-run the requirements
one-liner; it disables that default service so only the Alexa-Airplay target
names are advertised.

## Validate Locally

```bash
scripts/test.sh
```
