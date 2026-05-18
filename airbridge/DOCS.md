# AirBridge Documentation

## Options

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

## First Pairing

1. Put the Echo into Bluetooth pairing mode in the Alexa app or by voice.
2. Add its Bluetooth MAC address to the add-on options.
3. Start the add-on.
4. Select the configured AirPlay name from an iPhone or Mac.

## Notes

- AirBridge uses classic AirPlay through `shairport-sync`; it is an audio
  receiver, not an AirPlay video target.
- Each enabled target gets one TCP RAOP port and ten UDP ports derived from
  `airplay_port_base` and `udp_port_base`.
- If Home Assistant cannot expose host D-Bus or Bluetooth to the add-on, the
  add-on stays running and logs what is missing.
- HACS is not an installation path for this project because HACS does not
  manage Home Assistant add-ons.
