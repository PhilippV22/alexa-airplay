# AirBridge Home Assistant Add-on

AirBridge exposes one AirPlay receiver per configured Echo and forwards the
audio to that Echo over Bluetooth A2DP. It is intentionally small: no Node
server, no database, no Alexa Skill, no public HTTPS endpoint.

## Install

Add this repository to the Home Assistant Add-on Store, then install the
`AirBridge` add-on.

HACS is not used here. HACS installs custom integrations and frontend
resources; this project needs an add-on container because it runs
`shairport-sync`, BlueALSA and Bluetooth tooling next to Home Assistant.

## Configure

In the add-on options, add one target per Echo:

```yaml
log_level: info
adapter: hci0
reconnect_interval_seconds: 15
airplay_port_base: 5500
udp_port_base: 20000
targets:
  - name: Wohnzimmer Echo
    airplay_name: AirBridge Wohnzimmer
    mac: AA:BB:CC:DD:EE:FF
    enabled: true
```

Put the Echo into Bluetooth pairing mode once before the first start. After
that, AirBridge trusts and reconnects the device automatically.

## Validate Locally

```bash
scripts/test.sh
```

Set `AIRBRIDGE_DOCKER_BUILD=1` to also run a local Docker build.
