#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_PATH="${AIRBRIDGE_CONFIG_PATH:-/data/options.json}"
RUNTIME_DIR="${AIRBRIDGE_RUNTIME_DIR:-/tmp/airbridge}"
DRY_RUN="${AIRBRIDGE_DRY_RUN:-0}"

LOG_LEVEL="info"
ADAPTER="hci0"
RECONNECT_INTERVAL_SECONDS=15
AIRPLAY_PORT_BASE=5500
UDP_PORT_BASE=20000

BLUEALSA_PID=""
declare -a TARGET_IDS=()
declare -a TARGET_NAME=()
declare -a TARGET_AIRPLAY_NAME=()
declare -a TARGET_MAC=()
declare -a TARGET_ENABLED=()
declare -a TARGET_RAOP_PORT=()
declare -a TARGET_UDP_PORT_BASE=()
declare -a TARGET_CONFIG_PATH=()
declare -a SHAIRPORT_PID=()

level_value() {
  case "$1" in
    trace) echo 10 ;;
    debug) echo 20 ;;
    info) echo 30 ;;
    warning) echo 40 ;;
    error) echo 50 ;;
    *) echo 30 ;;
  esac
}

log() {
  local level="$1"
  shift
  if [[ "$(level_value "$level")" -lt "$(level_value "$LOG_LEVEL")" ]]; then
    return 0
  fi
  printf '[%s] [%s] %s\n' "$(date -Iseconds)" "$level" "$*" >&2
}

fatal() {
  log error "$*"
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  command_exists "$1" || fatal "Required command is missing: $1"
}

normalize_mac() {
  local mac="$1"
  printf '%s' "$mac" | tr '[:lower:]' '[:upper:]'
}

validate_mac() {
  [[ "$1" =~ ^([0-9A-F]{2}:){5}[0-9A-F]{2}$ ]]
}

escape_config_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

validate_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 ))
}

reset_runtime_dir() {
  case "$RUNTIME_DIR" in
    ""|"/"|"/tmp"|"/data"|"/run"|"/var")
      fatal "Refusing to reset unsafe runtime directory: $RUNTIME_DIR"
      ;;
  esac

  rm -rf -- "$RUNTIME_DIR"
  mkdir -p "$RUNTIME_DIR"
}

load_options() {
  require_command jq

  [[ -f "$CONFIG_PATH" ]] || fatal "Options file not found: $CONFIG_PATH"
  jq -e '.' "$CONFIG_PATH" >/dev/null || fatal "Options file is not valid JSON: $CONFIG_PATH"

  LOG_LEVEL="$(jq -r '.log_level // "info"' "$CONFIG_PATH")"
  ADAPTER="$(jq -r '.adapter // "hci0"' "$CONFIG_PATH")"
  RECONNECT_INTERVAL_SECONDS="$(jq -r '.reconnect_interval_seconds // 15' "$CONFIG_PATH")"
  AIRPLAY_PORT_BASE="$(jq -r '.airplay_port_base // 5500' "$CONFIG_PATH")"
  UDP_PORT_BASE="$(jq -r '.udp_port_base // 20000' "$CONFIG_PATH")"

  case "$LOG_LEVEL" in
    trace|debug|info|warning|error) ;;
    *) fatal "Invalid log_level: $LOG_LEVEL" ;;
  esac

  [[ "$RECONNECT_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || fatal "reconnect_interval_seconds must be an integer"
  (( RECONNECT_INTERVAL_SECONDS >= 5 && RECONNECT_INTERVAL_SECONDS <= 300 )) || fatal "reconnect_interval_seconds must be between 5 and 300"
  validate_port "$AIRPLAY_PORT_BASE" || fatal "airplay_port_base must be a TCP port"
  validate_port "$UDP_PORT_BASE" || fatal "udp_port_base must be a UDP port"

  local target_count
  target_count="$(jq '.targets // [] | length' "$CONFIG_PATH")"

  TARGET_IDS=()
  local seen_airplay_names="|"
  local index

  for (( index = 0; index < target_count; index++ )); do
    local id name airplay_name mac enabled raop_port udp_port
    id="$index"
    name="$(jq -r ".targets[$index].name // empty" "$CONFIG_PATH")"
    airplay_name="$(jq -r ".targets[$index].airplay_name // empty" "$CONFIG_PATH")"
    mac="$(normalize_mac "$(jq -r ".targets[$index].mac // empty" "$CONFIG_PATH")")"
    enabled="$(jq -r ".targets[$index].enabled // false" "$CONFIG_PATH")"

    [[ -n "$name" ]] || fatal "targets[$index].name is required"
    [[ -n "$airplay_name" ]] || fatal "targets[$index].airplay_name is required"
    validate_mac "$mac" || fatal "targets[$index].mac is invalid: $mac"
    [[ "$enabled" == "true" || "$enabled" == "false" ]] || fatal "targets[$index].enabled must be true or false"

    if [[ "$seen_airplay_names" == *"|$airplay_name|"* ]]; then
      fatal "Duplicate AirPlay name: $airplay_name"
    fi
    seen_airplay_names="${seen_airplay_names}${airplay_name}|"

    raop_port=$(( AIRPLAY_PORT_BASE + index ))
    udp_port=$(( UDP_PORT_BASE + index * 10 ))
    (( raop_port <= 65535 )) || fatal "AirPlay TCP port exceeds 65535 for $airplay_name"
    (( udp_port + 9 <= 65535 )) || fatal "AirPlay UDP port range exceeds 65535 for $airplay_name"

    TARGET_IDS+=("$id")
    TARGET_NAME["$id"]="$name"
    TARGET_AIRPLAY_NAME["$id"]="$airplay_name"
    TARGET_MAC["$id"]="$mac"
    TARGET_ENABLED["$id"]="$enabled"
    TARGET_RAOP_PORT["$id"]="$raop_port"
    TARGET_UDP_PORT_BASE["$id"]="$udp_port"
  done
}

write_shairport_config() {
  local id="$1"
  local conf_path="$RUNTIME_DIR/target_${id}.shairport-sync.conf"
  local airplay_name mac
  airplay_name="$(escape_config_string "${TARGET_AIRPLAY_NAME[$id]}")"
  mac="${TARGET_MAC[$id]}"

  mkdir -p "$RUNTIME_DIR"
  cat > "$conf_path" <<CONF
general = {
  name = "$airplay_name";
  output_backend = "alsa";
  port = ${TARGET_RAOP_PORT[$id]};
  udp_port_base = ${TARGET_UDP_PORT_BASE[$id]};
  udp_port_range = 10;
};

alsa = {
  output_device = "bluealsa:DEV=$mac";
  mixer_control_name = "";
};

metadata = {
  enabled = "no";
};
CONF

  TARGET_CONFIG_PATH["$id"]="$conf_path"
}

render_configs() {
  reset_runtime_dir

  local enabled_count=0
  local id
  if (( ${#TARGET_IDS[@]} > 0 )); then
    for id in "${TARGET_IDS[@]}"; do
      if [[ "${TARGET_ENABLED[$id]}" != "true" ]]; then
        log debug "target disabled: ${TARGET_NAME[$id]}"
        continue
      fi
      write_shairport_config "$id"
      enabled_count=$(( enabled_count + 1 ))
      local udp_end=$(( TARGET_UDP_PORT_BASE[$id] + 9 ))
      log info "AirPlay target configured: ${TARGET_AIRPLAY_NAME[$id]} -> ${TARGET_MAC[$id]} tcp=${TARGET_RAOP_PORT[$id]} udp=${TARGET_UDP_PORT_BASE[$id]}-$udp_end"
    done
  fi

  if (( enabled_count == 0 )); then
    log warning "no enabled targets configured"
  fi
}

start_avahi() {
  if ! command_exists avahi-daemon; then
    log warning "avahi-daemon is missing; AirPlay discovery may not work"
    return 1
  fi

  if avahi-daemon --check >/dev/null 2>&1; then
    log debug "avahi-daemon is already running"
    return 0
  fi

  mkdir -p /run/avahi-daemon
  log info "starting avahi-daemon for AirPlay discovery"
  if ! avahi-daemon --daemonize --no-drop-root --no-chroot >/dev/null 2>&1; then
    log warning "failed to start avahi-daemon; AirPlay discovery may not work"
    return 1
  fi
}

bluetooth_available() {
  if [[ ! -S /run/dbus/system_bus_socket && ! -S /var/run/dbus/system_bus_socket ]]; then
    log warning "host D-Bus socket is not available; Bluetooth control will be retried"
    return 1
  fi

  if ! command_exists bluetoothctl; then
    log warning "bluetoothctl is missing; Bluetooth control will be retried"
    return 1
  fi

  if ! bluetoothctl show "$ADAPTER" >/dev/null 2>&1; then
    log warning "Bluetooth adapter $ADAPTER is not available; check host Bluetooth and add-on permissions"
    return 1
  fi

  return 0
}

bluetoothctl_batch() {
  local timeout="$1"
  shift
  printf '%s\n' "$@" | bluetoothctl --timeout "$timeout" 2>&1
}

prepare_adapter() {
  bluetooth_available || return 1

  local output
  output="$(bluetoothctl_batch 10 \
    "select $ADAPTER" \
    "power on" \
    "agent NoInputNoOutput" \
    "default-agent" || true)"

  if [[ "$output" == *"No default controller available"* || "$output" == *"not available"* ]]; then
    log warning "failed to prepare Bluetooth adapter $ADAPTER: $output"
    return 1
  fi

  log info "Bluetooth adapter ready: $ADAPTER"
  return 0
}

device_info() {
  local mac="$1"
  bluetoothctl info "$mac" 2>/dev/null || true
}

device_is_paired() {
  device_info "$1" | grep -q 'Paired: yes'
}

device_is_connected() {
  device_info "$1" | grep -q 'Connected: yes'
}

trust_device() {
  local mac="$1"
  bluetoothctl trust "$mac" >/dev/null 2>&1 || log debug "trust command failed for $mac"
}

pair_device_if_needed() {
  local mac="$1"

  if device_is_paired "$mac"; then
    log debug "Bluetooth device already paired: $mac"
    trust_device "$mac"
    return 0
  fi

  log info "pairing Bluetooth device: $mac"
  local output
  output="$(bluetoothctl_batch 35 "pair $mac" || true)"

  if device_is_paired "$mac"; then
    trust_device "$mac"
    log info "Bluetooth device paired: $mac"
    return 0
  fi

  log warning "pairing failed for $mac; if it is already paired on the host, connection will still be attempted: $output"
  trust_device "$mac"
  return 0
}

a2dp_is_listed() {
  local mac="$1"
  command_exists bluealsa-aplay || return 1
  bluealsa-aplay -l 2>/dev/null | tr '[:lower:]' '[:upper:]' | grep -q "$mac"
}

connect_device() {
  local id="$1"
  local mac="${TARGET_MAC[$id]}"

  bluetooth_available || return 1

  if device_is_connected "$mac"; then
    if a2dp_is_listed "$mac"; then
      log debug "Bluetooth device connected with A2DP: $mac"
    else
      log debug "Bluetooth device connected; A2DP is not listed yet: $mac"
    fi
    return 0
  fi

  pair_device_if_needed "$mac"

  log info "connecting Bluetooth device for ${TARGET_AIRPLAY_NAME[$id]}: $mac"
  local output
  output="$(bluetoothctl connect "$mac" 2>&1 || true)"

  if [[ "$output" == *"Connection successful"* || "$output" == *"AlreadyConnected"* || "$output" == *"Already connected"* ]]; then
    log info "Bluetooth connected: $mac"
    return 0
  fi

  if [[ "$output" == *"br-connection-busy"* ]]; then
    if a2dp_is_listed "$mac"; then
      log info "Bluetooth busy but A2DP is active: $mac"
      return 0
    fi
    log warning "Bluetooth busy without A2DP; reconnecting: $mac"
    bluetoothctl disconnect "$mac" >/dev/null 2>&1 || true
    sleep 2
    bluetoothctl connect "$mac" >/dev/null 2>&1 || true
    return 0
  fi

  if device_is_connected "$mac"; then
    log info "Bluetooth connected: $mac"
    return 0
  fi

  log warning "Bluetooth connect failed for $mac: $output"
  return 1
}

start_bluealsa() {
  if [[ -n "$BLUEALSA_PID" ]] && kill -0 "$BLUEALSA_PID" >/dev/null 2>&1; then
    return 0
  fi

  if ! command_exists bluealsa; then
    log warning "bluealsa is missing; audio output cannot start"
    return 1
  fi

  log info "starting BlueALSA A2DP source"
  bluealsa --profile=a2dp-source &
  BLUEALSA_PID="$!"
  sleep 1

  if ! kill -0 "$BLUEALSA_PID" >/dev/null 2>&1; then
    log warning "bluealsa exited immediately"
    BLUEALSA_PID=""
    return 1
  fi
}

start_shairport() {
  local id="$1"

  if [[ -n "${SHAIRPORT_PID[$id]:-}" ]] && kill -0 "${SHAIRPORT_PID[$id]}" >/dev/null 2>&1; then
    return 0
  fi

  if ! command_exists shairport-sync; then
    log warning "shairport-sync is missing; AirPlay receiver cannot start"
    return 1
  fi

  log info "starting AirPlay receiver: ${TARGET_AIRPLAY_NAME[$id]}"
  shairport-sync -c "${TARGET_CONFIG_PATH[$id]}" &
  SHAIRPORT_PID["$id"]="$!"
  sleep 1

  if ! kill -0 "${SHAIRPORT_PID[$id]}" >/dev/null 2>&1; then
    log warning "shairport-sync exited immediately for ${TARGET_AIRPLAY_NAME[$id]}"
    SHAIRPORT_PID["$id"]=""
    return 1
  fi

  log info "AirPlay receiver ready: ${TARGET_AIRPLAY_NAME[$id]}"
}

cleanup() {
  local id
  if (( ${#TARGET_IDS[@]} > 0 )); then
    for id in "${TARGET_IDS[@]}"; do
      if [[ -n "${SHAIRPORT_PID[$id]:-}" ]]; then
        kill "${SHAIRPORT_PID[$id]}" >/dev/null 2>&1 || true
      fi
    done
  fi

  if [[ -n "$BLUEALSA_PID" ]]; then
    kill "$BLUEALSA_PID" >/dev/null 2>&1 || true
  fi
}

monitor_loop() {
  local enabled_count=0
  local id
  if (( ${#TARGET_IDS[@]} > 0 )); then
    for id in "${TARGET_IDS[@]}"; do
      [[ "${TARGET_ENABLED[$id]}" == "true" ]] && enabled_count=$(( enabled_count + 1 ))
    done
  fi

  if (( enabled_count == 0 )); then
    while true; do
      sleep "$RECONNECT_INTERVAL_SECONDS"
    done
  fi

  while true; do
    if [[ -n "$BLUEALSA_PID" ]] && ! kill -0 "$BLUEALSA_PID" >/dev/null 2>&1; then
      log warning "bluealsa stopped; restarting"
      BLUEALSA_PID=""
      start_bluealsa || true
    fi

    prepare_adapter || true

    if (( ${#TARGET_IDS[@]} > 0 )); then
      for id in "${TARGET_IDS[@]}"; do
        [[ "${TARGET_ENABLED[$id]}" == "true" ]] || continue
        start_shairport "$id" || true
        connect_device "$id" || true
      done
    fi

    sleep "$RECONNECT_INTERVAL_SECONDS"
  done
}

main() {
  load_options
  render_configs

  if [[ "$DRY_RUN" == "1" ]]; then
    log info "dry run complete"
    return 0
  fi

  trap cleanup EXIT
  trap 'exit 0' INT TERM

  start_avahi || true
  start_bluealsa || true
  prepare_adapter || true

  local id
  if (( ${#TARGET_IDS[@]} > 0 )); then
    for id in "${TARGET_IDS[@]}"; do
      [[ "${TARGET_ENABLED[$id]}" == "true" ]] || continue
      connect_device "$id" || true
      start_shairport "$id" || true
    done
  fi

  monitor_loop
}

main "$@"
