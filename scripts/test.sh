#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$ROOT_DIR/airbridge/run.sh" "$ROOT_DIR/scripts/run_sh_validation_test.sh"
else
  echo "shellcheck not found; skipping shell lint"
fi

"$ROOT_DIR/scripts/run_sh_validation_test.sh"

if command -v ruby >/dev/null 2>&1; then
  ruby -ryaml -e '
    root = ARGV.fetch(0)
    %w[
      repository.yaml
      airbridge/config.yaml
      airbridge/translations/de.yaml
      airbridge/translations/en.yaml
    ].each do |rel|
      YAML.safe_load(File.read(File.join(root, rel)), permitted_classes: [Symbol], aliases: false)
      puts "yaml ok: #{rel}"
    end
  ' "$ROOT_DIR"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$ROOT_DIR" <<'PY'
import sys
from pathlib import Path

try:
    import yaml
except Exception:
    print("python yaml module not found; skipping YAML parse")
    sys.exit(0)

root = Path(sys.argv[1])
for rel in [
    "repository.yaml",
    "airbridge/config.yaml",
    "airbridge/translations/de.yaml",
    "airbridge/translations/en.yaml",
]:
    with (root / rel).open("r", encoding="utf-8") as handle:
        yaml.safe_load(handle)
    print(f"yaml ok: {rel}")
PY
else
  echo "ruby/python3 not found; skipping YAML parse"
fi

if [[ "${AIRBRIDGE_DOCKER_BUILD:-0}" == "1" ]]; then
  docker build --build-arg BUILD_ARCH=amd64 --build-arg BUILD_VERSION=1.0.0 "$ROOT_DIR/airbridge"
else
  echo "AIRBRIDGE_DOCKER_BUILD=1 not set; skipping Docker build"
fi
