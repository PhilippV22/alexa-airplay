#!/usr/bin/env bash
set -Eeuo pipefail

REQUIRED_COMMANDS=(shairport-sync bluetoothctl bluealsa bluealsa-aplay avahi-daemon)

log() {
  printf '[Alexa-Airplay] %s\n' "$*"
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "This installer must run as root, and sudo is not installed." >&2
    exit 1
  fi
  exec sudo -E bash "$0" "$@"
fi

install_host_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "Host is not apt-based; skipping host package install."
    return 0
  fi

  export DEBIAN_FRONTEND=noninteractive

  log "Installing host packages with apt."
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
    disable_default_shairport_service
  fi

  for user in homeassistant hass hassio; do
    if id "$user" >/dev/null 2>&1; then
      usermod -aG bluetooth,audio "$user" || true
    fi
  done
}

disable_default_shairport_service() {
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    return 0
  fi

  # The package default service advertises the host name, often "server", as an
  # AirPlay receiver. Alexa-Airplay starts its own shairport-sync instances with
  # per-target names, so the default service only creates confusion and can hold
  # RAOP/mDNS resources.
  local units=(
    shairport-sync.service
    shairport-sync@.service
  )
  local unit
  for unit in "${units[@]}"; do
    if systemctl list-unit-files "$unit" >/dev/null 2>&1; then
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
    fi
  done
}

detect_homeassistant_container() {
  if [[ -n "${AIRBRIDGE_HA_CONTAINER:-}" ]]; then
    printf '%s\n' "$AIRBRIDGE_HA_CONTAINER"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  docker ps --format '{{.Names}}\t{{.Image}}' | awk '
    $2 ~ /home-assistant\/home-assistant|ghcr.io\/home-assistant\/home-assistant/ { print $1; exit }
    $1 ~ /^(homeassistant|home-assistant|ha)$/ { print $1; exit }
  '
}

install_container_packages() {
  local container="$1"
  [[ -n "$container" ]] || return 0

  log "Installing packages inside Home Assistant container: $container"
  docker exec "$container" sh -s <<'SH'
set -eu

if command -v apk >/dev/null 2>&1; then
  apk add --no-cache \
    alsa-utils \
    avahi \
    bash \
    bluez \
    bluez-alsa \
    bluez-alsa-utils \
    dbus \
    shairport-sync
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    alsa-utils \
    avahi-daemon \
    bluez \
    bluez-alsa-utils \
    dbus \
    shairport-sync
else
  echo "No supported package manager found in Home Assistant container." >&2
  exit 42
fi

missing=""
for cmd in shairport-sync bluetoothctl bluealsa bluealsa-aplay avahi-daemon; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing="$missing $cmd"
  fi
done

if [ -n "$missing" ]; then
  echo "Container package install finished, but commands are missing:$missing" >&2
  exit 1
fi
SH

  docker exec "$container" sh -c 'pkill -f "^shairport-sync( |$)" 2>/dev/null || true' || true

  local network_mode
  network_mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null || true)"
  if [[ "$network_mode" != "host" ]]; then
    log "WARNING: container network mode is '$network_mode'. AirPlay/mDNS discovery normally needs network_mode: host."
  fi

  local dbus_mount
  dbus_mount="$(docker exec "$container" sh -c 'test -S /run/dbus/system_bus_socket || test -S /var/run/dbus/system_bus_socket; echo $?' 2>/dev/null || echo 1)"
  if [[ "$dbus_mount" != "0" ]]; then
    log "WARNING: host D-Bus socket is not visible inside the container. Bluetooth control will not work."
    log "Mount /run/dbus:/run/dbus:ro into the Home Assistant container."
  fi
}

check_host_commands() {
  local missing=()
  local cmd
  for cmd in "${REQUIRED_COMMANDS[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    log "Host commands still missing: ${missing[*]}"
    return 1
  fi
}

check_container_commands() {
  local container="$1"
  [[ -n "$container" ]] || return 0

  docker exec "$container" sh -c '
missing=""
for cmd in shairport-sync bluetoothctl bluealsa bluealsa-aplay avahi-daemon; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing="$missing $cmd"
  fi
done
if [ -n "$missing" ]; then
  echo "$missing"
  exit 1
fi
'
}

install_host_packages

container="$(detect_homeassistant_container || true)"
if [[ -n "$container" ]]; then
  install_container_packages "$container"
  check_container_commands "$container"
else
  log "No running Home Assistant container detected. Set AIRBRIDGE_HA_CONTAINER=<container-name> to force one."
fi

check_host_commands || true

log "Alexa-Airplay requirements installed successfully."
log "Restart Home Assistant after this installer finishes."
