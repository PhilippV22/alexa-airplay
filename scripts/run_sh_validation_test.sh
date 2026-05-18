#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT_DIR/airbridge/run.sh"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

run_dry() {
  AIRBRIDGE_CONFIG_PATH="$1" \
  AIRBRIDGE_RUNTIME_DIR="$2" \
  AIRBRIDGE_DRY_RUN=1 \
    bash "$RUN_SH"
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    echo "Expected $file to contain: $needle" >&2
    exit 1
  fi
}

write_options() {
  local path="$1"
  local targets_json="$2"
  cat > "$path" <<JSON
{
  "log_level": "debug",
  "adapter": "hci0",
  "reconnect_interval_seconds": 15,
  "airplay_port_base": 5500,
  "udp_port_base": 20000,
  "targets": $targets_json
}
JSON
}

valid_options="$TMP_DIR/valid.json"
valid_runtime="$TMP_DIR/runtime-valid"
write_options "$valid_options" '[{"name":"Wohnzimmer Echo","airplay_name":"AirBridge Wohnzimmer","mac":"aa:bb:cc:dd:ee:ff","enabled":true}]'
run_dry "$valid_options" "$valid_runtime"
assert_file_contains "$valid_runtime/target_0.shairport-sync.conf" 'name = "AirBridge Wohnzimmer";'
assert_file_contains "$valid_runtime/target_0.shairport-sync.conf" 'output_device = "bluealsa:DEV=AA:BB:CC:DD:EE:FF";'
assert_file_contains "$valid_runtime/target_0.shairport-sync.conf" 'port = 5500;'

empty_options="$TMP_DIR/empty.json"
empty_runtime="$TMP_DIR/runtime-empty"
write_options "$empty_options" '[]'
run_dry "$empty_options" "$empty_runtime"
if find "$empty_runtime" -type f | grep -q .; then
  echo "Expected no shairport configs for empty target list" >&2
  exit 1
fi

invalid_mac_options="$TMP_DIR/invalid-mac.json"
write_options "$invalid_mac_options" '[{"name":"Bad","airplay_name":"AirBridge Bad","mac":"not-a-mac","enabled":true}]'
if run_dry "$invalid_mac_options" "$TMP_DIR/runtime-invalid-mac"; then
  echo "Expected invalid MAC configuration to fail" >&2
  exit 1
fi

duplicate_options="$TMP_DIR/duplicate.json"
write_options "$duplicate_options" '[{"name":"One","airplay_name":"AirBridge Same","mac":"AA:BB:CC:DD:EE:01","enabled":true},{"name":"Two","airplay_name":"AirBridge Same","mac":"AA:BB:CC:DD:EE:02","enabled":true}]'
if run_dry "$duplicate_options" "$TMP_DIR/runtime-duplicate"; then
  echo "Expected duplicate AirPlay name configuration to fail" >&2
  exit 1
fi

echo "run.sh validation tests passed"
