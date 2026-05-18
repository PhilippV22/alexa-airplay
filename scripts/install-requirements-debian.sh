#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "This installer must run as root, and sudo is not installed." >&2
    exit 1
  fi
  exec sudo -E bash "$0" "$@"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This automatic installer supports apt-based hosts only: Debian, Ubuntu, Raspberry Pi OS." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  alsa-utils \
  avahi-daemon \
  bluez \
  bluez-alsa-utils \
  dbus \
  shairport-sync

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  systemctl enable --now bluetooth.service || true
  systemctl enable --now avahi-daemon.service || true
  systemctl enable --now bluealsa.service || true
fi

for user in homeassistant hass hassio; do
  if id "$user" >/dev/null 2>&1; then
    usermod -aG bluetooth,audio "$user" || true
  fi
done

missing=()
for cmd in shairport-sync bluetoothctl bluealsa bluealsa-aplay avahi-daemon; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Install finished, but these commands are still missing: ${missing[*]}" >&2
  exit 1
fi

echo "Alexa-Airplay requirements installed successfully."
echo "If Home Assistant runs as a service user, restart Home Assistant or reboot so group changes apply."
