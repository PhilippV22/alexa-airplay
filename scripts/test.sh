#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$ROOT_DIR/scripts/test.sh" "$ROOT_DIR/scripts/install-requirements-debian.sh"
else
  echo "shellcheck not found; skipping shell lint"
fi

python3 -m compileall -q "$ROOT_DIR/custom_components/airbridge"
python3 "$ROOT_DIR/scripts/runtime_validation_test.py"

for asset in \
  "$ROOT_DIR/custom_components/airbridge/brand/icon.png" \
  "$ROOT_DIR/custom_components/airbridge/brand/logo.png" \
  "$ROOT_DIR/custom_components/airbridge/brand/icon@2x.png" \
  "$ROOT_DIR/custom_components/airbridge/brand/logo@2x.png"; do
  if [[ ! -s "$asset" ]]; then
    echo "missing brand asset: $asset" >&2
    exit 1
  fi
  echo "brand asset ok: ${asset#$ROOT_DIR/}"
done

if command -v ruby >/dev/null 2>&1; then
  ruby -rjson -e '
    root = ARGV.fetch(0)
    %w[
      hacs.json
      custom_components/airbridge/manifest.json
      custom_components/airbridge/strings.json
      custom_components/airbridge/translations/de.json
    ].each do |rel|
      JSON.parse(File.read(File.join(root, rel)))
      puts "json ok: #{rel}"
    end
  ' "$ROOT_DIR"
  ruby -ryaml -e '
    root = ARGV.fetch(0)
    %w[
      custom_components/airbridge/services.yaml
    ].each do |rel|
      YAML.safe_load(File.read(File.join(root, rel)), aliases: false)
      puts "yaml ok: #{rel}"
    end
  ' "$ROOT_DIR"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$ROOT_DIR" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for rel in [
    "hacs.json",
    "custom_components/airbridge/manifest.json",
    "custom_components/airbridge/strings.json",
    "custom_components/airbridge/translations/de.json",
]:
    with (root / rel).open("r", encoding="utf-8") as handle:
        json.load(handle)
    print(f"json ok: {rel}")
PY
else
  echo "ruby/python3 not found; skipping JSON parse"
fi
