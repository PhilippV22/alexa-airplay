#!/usr/bin/env bash
set -euo pipefail

PORT="${AIRBRIDGE_PORT:-3000}"
HOST="${AIRBRIDGE_BIND_HOST:-0.0.0.0}"

declare -a URLS
URLS=("http://127.0.0.1:${PORT}/health/live")

if [[ -n "${HOST}" && "${HOST}" != "0.0.0.0" && "${HOST}" != "::" && "${HOST}" != "127.0.0.1" && "${HOST}" != "localhost" ]]; then
  URLS+=("http://${HOST}:${PORT}/health/live")
fi

for url in "${URLS[@]}"; do
  for _attempt in 1 2 3; do
    if curl -fsS --max-time 5 "${url}" >/dev/null; then
      exit 0
    fi
    sleep 1
  done
done

logger -t airbridge-watchdog "health check failed for all endpoints, restarting airbridge.service"
systemctl restart airbridge.service
