#!/usr/bin/env bash
set -euo pipefail

PORT="${AIRBRIDGE_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health/live"

if curl -fsS --max-time 5 "${HEALTH_URL}" >/dev/null; then
  exit 0
fi

logger -t airbridge-watchdog "health check failed, restarting airbridge.service"
systemctl restart airbridge.service
