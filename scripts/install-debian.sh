#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

set +u
_SELF="${BASH_SOURCE[0]:-}"
set -u

REPO_DIR=""
if [[ $# -ge 1 ]]; then
  REPO_DIR="${1}"
elif [[ -f "$(pwd)/package.json" ]]; then
  REPO_DIR="$(pwd)"
elif [[ -n "${_SELF}" ]]; then
  _SCRIPT_DIR="$(cd -- "$(dirname -- "${_SELF}")" && pwd)"
  if [[ -f "${_SCRIPT_DIR}/../package.json" ]]; then
    REPO_DIR="$(cd "${_SCRIPT_DIR}/.." && pwd)"
  fi
fi

# Pipe-Modus (curl | bash): kein Repo gefunden -> automatisch clonen
if [[ -z "${REPO_DIR}" || ! -f "${REPO_DIR}/package.json" ]]; then
  echo "Kein lokales Repo gefunden – klone von GitHub..."
  apt-get update -qq
  apt-get install -y -qq git ca-certificates
  CLONE_DIR="$(mktemp -d)"
  git clone --depth=1 https://github.com/PhilippV22/alexa-airplay.git "${CLONE_DIR}"
  REPO_DIR="${CLONE_DIR}"
  echo "Repo geklont nach: ${REPO_DIR}"
fi
APP_USER="airbridge"
APP_GROUP="airbridge"
APP_DIR="/opt/airbridge"
ENV_DIR="/etc/airbridge"
ENV_FILE="${ENV_DIR}/airbridge.env"
DATA_DIR="/var/lib/airbridge"
RUN_DIR="/run/airbridge"

upsert_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp_file

  tmp_file="$(mktemp)"
  awk -v k="${key}" -v v="${value}" '
    BEGIN { updated = 0 }
    $0 ~ "^" k "=" {
      print k "=" v
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print k "=" v
      }
    }
  ' "${file}" > "${tmp_file}"
  mv "${tmp_file}" "${file}"
}

if [[ ! -f "${REPO_DIR}/package.json" ]]; then
  echo "Invalid repo path: ${REPO_DIR}" >&2
  exit 1
fi

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  if [[ "${ID:-}" != "debian" && "${ID:-}" != "ubuntu" ]]; then
    echo "Warning: script is optimized for Debian/Ubuntu. Detected ${ID:-unknown}." >&2
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg rsync openssl sudo \
  sqlite3 ffmpeg shairport-sync \
  bluez bluez-alsa-utils

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is missing after Node install" >&2
  exit 1
fi

if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${APP_GROUP}"
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

# Bluetooth: airbridge user muss in bluetooth-Gruppe sein
usermod -aG bluetooth "${APP_USER}" 2>/dev/null || true

# BlueALSA daemon aktivieren (stellt ALSA BT-Devices bereit)
systemctl enable --now bluealsa.service 2>/dev/null || true

install -d -o "${APP_USER}" -g "${APP_GROUP}" "${APP_DIR}"
install -d -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}" "${DATA_DIR}/db"
install -d -o "${APP_USER}" -g "${APP_GROUP}" "${RUN_DIR}"
install -d -o root -g "${APP_GROUP}" -m 0770 "${ENV_DIR}"

rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'var' \
  --exclude 'run' \
  "${REPO_DIR}/" "${APP_DIR}/"

cd "${APP_DIR}"
if npm ci; then
  echo "npm ci succeeded."
else
  echo "Warning: npm ci failed (lockfile mismatch). Falling back to npm install." >&2
  npm install
fi
npm run build

chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}" "${DATA_DIR}"
# /run may be tmpfs-managed and can disappear during long installs; recreate before chown.
install -d -o "${APP_USER}" -g "${APP_GROUP}" "${RUN_DIR}"
chown -R "${APP_USER}:${APP_GROUP}" "${RUN_DIR}"

install -m 0644 deploy/systemd/airbridge.service /etc/systemd/system/airbridge.service
install -m 0644 deploy/systemd/airbridge-watchdog.service /etc/systemd/system/airbridge-watchdog.service
install -m 0644 deploy/systemd/airbridge-watchdog.timer /etc/systemd/system/airbridge-watchdog.timer

if [[ ! -f "${ENV_FILE}" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"

  cat > "${ENV_FILE}" <<ENV
# Managed by AirBridge installer and Web UI
AIRBRIDGE_BIND_HOST=0.0.0.0
AIRBRIDGE_PORT=3000
AIRBRIDGE_TRUST_PROXY=false
AIRBRIDGE_SESSION_SECRET=${SESSION_SECRET}
AIRBRIDGE_ADMIN_USER=admin
AIRBRIDGE_ADMIN_PASSWORD=${ADMIN_PASSWORD}
AIRBRIDGE_SESSION_TTL_SECONDS=28800
AIRBRIDGE_AUTH_RATE_LIMIT=12
AIRBRIDGE_SHAIRPORT_BIN=/usr/bin/shairport-sync
AIRBRIDGE_FFMPEG_BIN=/usr/bin/ffmpeg
AIRBRIDGE_FFMPEG_BITRATE=192k
AIRBRIDGE_SPAWN_PROCESSES=true
AIRBRIDGE_MONITOR_INTERVAL_MS=2000
AIRBRIDGE_DATA_ROOT=/var/lib/airbridge
AIRBRIDGE_RUN_ROOT=/run/airbridge
AIRBRIDGE_DB_PATH=/var/lib/airbridge/db/airbridge.sqlite
AIRBRIDGE_SETUP_ENV_FILE=/etc/airbridge/airbridge.env
AIRBRIDGE_SERVICE_NAME=airbridge.service
ENV

else
  ADMIN_PASSWORD="(bereits gesetzt – in ${ENV_FILE} nachschlagen oder Passwort in Web-UI aendern)"
  echo "Keeping existing ${ENV_FILE}"
fi

chown root:"${APP_GROUP}" "${ENV_FILE}" || true
chmod 0660 "${ENV_FILE}" || true

systemctl daemon-reload
systemctl enable --now airbridge.service
systemctl enable --now airbridge-watchdog.timer

HOST_IP="$(hostname -I | awk '{print $1}')"

echo ""
echo "============================================================"
echo "  AirBridge Installation abgeschlossen!"
echo "============================================================"
echo ""
echo "  Web UI:         http://${HOST_IP}:3000"
echo "  Admin User:     admin"
echo "  Admin Passwort: ${ADMIN_PASSWORD}"
echo ""
echo "  Env-Datei:      ${ENV_FILE}"
echo ""
echo "Naechste Schritte:"
echo ""
echo "  1) Browser oeffnen: http://${HOST_IP}:3000"
echo "     Login mit: admin / ${ADMIN_PASSWORD}"
echo ""
echo "  2) Bluetooth Setup -> 'Bluetooth scannen'"
echo "     Echo in Alexa-App in Pairing-Modus setzen,"
echo "     dann in Web-UI scannen und 'Koppeln & Target erstellen' klicken"
echo ""
echo "  3) Ziel-Target aktivieren (Enable) und 'Reconcile' klicken"
echo ""
echo "  4) AirPlay-Quelle (iPhone/Mac) -> AirPlay -> AirBridge <Name>"
echo "     Audio wird per Bluetooth direkt zum Echo uebertragen"
echo ""
echo "  Logs verfolgen: journalctl -fu airbridge.service"
echo "============================================================"
