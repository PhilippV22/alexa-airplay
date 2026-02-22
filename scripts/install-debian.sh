#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

APP_USER="airbridge"
APP_GROUP="airbridge"
APP_DIR="/opt/airbridge"
ENV_DIR="/etc/airbridge"
DATA_DIR="/var/lib/airbridge"
RUN_DIR="/run/airbridge"

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg sqlite3 ffmpeg shairport-sync cloudflared

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${APP_GROUP}"
  fi
  useradd --system --gid "${APP_GROUP}" --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

install -d -o "${APP_USER}" -g "${APP_GROUP}" "${APP_DIR}" "${DATA_DIR}" "${DATA_DIR}/hls" "${DATA_DIR}/db"
install -d -o "${APP_USER}" -g "${APP_GROUP}" "${RUN_DIR}"
install -d -m 0750 "${ENV_DIR}"
install -d -m 0750 /etc/credstore.encrypted

if [[ ! -f package.json ]]; then
  echo "Run this script from the repository root." >&2
  exit 1
fi

npm ci
npm run build

cp -a dist package.json package-lock.json node_modules src scripts deploy "${APP_DIR}/"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}" "${DATA_DIR}" "${RUN_DIR}"

install -m 0644 deploy/systemd/airbridge.service /etc/systemd/system/airbridge.service
install -m 0644 deploy/systemd/cloudflared-airbridge.service /etc/systemd/system/cloudflared-airbridge.service
install -m 0644 deploy/systemd/airbridge-watchdog.service /etc/systemd/system/airbridge-watchdog.service
install -m 0644 deploy/systemd/airbridge-watchdog.timer /etc/systemd/system/airbridge-watchdog.timer

if [[ ! -f "${ENV_DIR}/airbridge.env" ]]; then
  cp .env.example "${ENV_DIR}/airbridge.env"
  chmod 0640 "${ENV_DIR}/airbridge.env"
fi

if [[ ! -f "${ENV_DIR}/cloudflared.yml" ]]; then
  cp deploy/cloudflared/config.yml.template "${ENV_DIR}/cloudflared.yml"
  chmod 0640 "${ENV_DIR}/cloudflared.yml"
fi

systemctl daemon-reload
systemctl enable airbridge.service airbridge-watchdog.timer

echo "Installation complete."
echo "1) Edit ${ENV_DIR}/airbridge.env"
echo "2) Add encrypted credential in /etc/credstore.encrypted/airbridge_alexa_cookie"
echo "3) Configure tunnel in ${ENV_DIR}/cloudflared.yml and enable cloudflared-airbridge.service"
echo "4) Start service: systemctl start airbridge.service"
