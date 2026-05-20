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
packages through HACS itself. Alexa-Airplay will try a best-effort automatic
install inside the Home Assistant runtime when it is running as root and finds
`apk` or `apt-get`. If that is not possible, these commands must be available
inside the Home Assistant runtime:

- `shairport-sync`
- `bluealsa`
- `bluealsa-aplay`
- `aplay`
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

## Use from Home Assistant

Alexa-Airplay exposes Home Assistant buttons so Bluetooth maintenance does not
need a shell inside the container:

- `Restart` restarts all Alexa-Airplay runtime processes.
- `<AirPlay name> Bluetooth pair` pairs, trusts and connects one Echo.
- `<AirPlay name> reconnect` reconnects one Echo and restarts its AirPlay
  receiver if needed. It does not start a new pairing session.
- `<AirPlay name> Bluetooth forget` removes the local Bluetooth pairing for one
  Echo.

The same actions are available as services for dashboards and automations:
`airbridge.restart`, `airbridge.pair`, `airbridge.reconnect` and
`airbridge.forget`. The per-target services accept the optional `target_id`
shown in the target status sensor attributes.

If an Echo is visible in AirPlay but iPhone or Mac says the connection failed,
open the Alexa-Airplay device in Home Assistant, press `Bluetooth forget`, put
the Echo in Bluetooth pairing mode, then press `Bluetooth pair`. If the Echo was
previously paired with a phone or computer, remove that old pairing there too.

The target status sensor distinguishes plain Bluetooth from the usable audio
path: `connected` means BlueZ is connected to the Echo, while `bluealsa_ready`
means BlueALSA can open the A2DP audio output that AirPlay needs. Alexa-Airplay
only keeps the AirPlay receiver active once both are true, so an Echo should no
longer stay visible in AirPlay while its Bluetooth audio path is not ready.
For reliability with BlueALSA, the generated Shairport Sync config uses
software volume, ignores AirPlay source volume, adds output headroom and routes
audio through Shairport Sync's raw PCM pipe backend. A dedicated `aplay` process
feeds that PCM stream into BlueALSA, which
avoids Shairport Sync's ALSA timing layer underrunning against Bluetooth's
variable latency. BlueALSA is started as an A2DP source with stable high-quality
SBC where the installed BlueALSA version supports that option.

## How it works

For every enabled target, Alexa-Airplay writes a `shairport-sync` config under
`/config/airbridge`, starts `shairport-sync`, starts BlueALSA as an A2DP source,
and uses `bluetoothctl` to pair, trust and reconnect the Echo.

If the Home Assistant runtime cannot access Bluetooth, D-Bus or the required
commands, the integration still loads and exposes the problem as entity state
and attributes.

If no AirPlay receiver appears on iPhone or Mac, check the `Runtime` sensor
attributes first. `shairport-sync` and `avahi-daemon` must be present inside
the Home Assistant runtime, not only on the Docker host. The attributes
`auto_install_state`, `auto_install_error` and `auto_install_output` show
whether Alexa-Airplay could install missing packages automatically.

If you only see an old AirPlay receiver named `server`, that is usually the
package default `shairport-sync` service on the host. Re-run the requirements
one-liner; it disables that default service so only the Alexa-Airplay target
names are advertised.

## Validate Locally

```bash
scripts/test.sh
```
