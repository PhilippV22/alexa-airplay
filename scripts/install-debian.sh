#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -ge 1 ]]; then
  REPO_DIR="${1}"
elif [[ -f "$(pwd)/package.json" ]]; then
  REPO_DIR="$(pwd)"
elif [[ -f "${SCRIPT_DIR}/../package.json" ]]; then
  REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  REPO_DIR="$(pwd)"
fi
APP_USER="airbridge"
APP_GROUP="airbridge"
APP_DIR="/opt/airbridge"
ENV_DIR="/etc/airbridge"
ENV_FILE="${ENV_DIR}/airbridge.env"
CLOUDFLARED_FILE="${ENV_DIR}/cloudflared.yml"
DATA_DIR="/var/lib/airbridge"
RUN_DIR="/run/airbridge"
CRED_DIR="/etc/credstore.encrypted"
ENC_COOKIE_FILE="${CRED_DIR}/airbridge_alexa_cookie"
PLAIN_COOKIE_FILE="${ENV_DIR}/alexa-cookie.txt"

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

# Interaktiv: Stream-URL und Skill-URL abfragen (vor apt, damit User nicht wartet)
STREAM_URL_INPUT=""
SKILL_URL_INPUT=""
if [[ -t 0 ]]; then
  echo ""
  echo "=== AirBridge Setup ==="
  read -r -p "Cloudflared Stream-URL fuer HLS (z.B. https://stream.deinedomain.com) [leer = spaeter in Web-UI setzen]: " STREAM_URL_INPUT
  read -r -p "Cloudflared Skill-URL fuer Alexa (z.B. https://skill.deinedomain.com) [leer = spaeter]: " SKILL_URL_INPUT
  echo ""
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg rsync openssl sudo \
  sqlite3 ffmpeg shairport-sync

CLOUDFLARED_INSTALLED="false"
if apt-cache show cloudflared >/dev/null 2>&1; then
  if apt-get install -y --no-install-recommends cloudflared; then
    CLOUDFLARED_INSTALLED="true"
  else
    echo "Warning: cloudflared installation failed. Continuing without it." >&2
  fi
else
  echo "Warning: cloudflared package not found in current apt sources. Continuing without it." >&2
fi

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

install -d -o "${APP_USER}" -g "${APP_GROUP}" "${APP_DIR}"
install -d -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}" "${DATA_DIR}/hls" "${DATA_DIR}/db"
install -d -o "${APP_USER}" -g "${APP_GROUP}" "${RUN_DIR}"
install -d -o root -g "${APP_GROUP}" -m 0770 "${ENV_DIR}"
install -d -o root -g "${APP_GROUP}" -m 0770 "${CRED_DIR}"

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
install -m 0644 deploy/systemd/cloudflared-airbridge.service /etc/systemd/system/cloudflared-airbridge.service
install -m 0644 deploy/systemd/airbridge-watchdog.service /etc/systemd/system/airbridge-watchdog.service
install -m 0644 deploy/systemd/airbridge-watchdog.timer /etc/systemd/system/airbridge-watchdog.timer

if [[ ! -f "${ENV_FILE}" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"

  STREAM_URL="${STREAM_URL_INPUT:-https://stream.airbridge.example.com}"

  cat > "${ENV_FILE}" <<ENV
# Managed by AirBridge installer and Web UI
AIRBRIDGE_BIND_HOST=0.0.0.0
AIRBRIDGE_PORT=3000
AIRBRIDGE_TRUST_PROXY=false
AIRBRIDGE_SESSION_SECRET=${SESSION_SECRET}
AIRBRIDGE_STREAM_BASE_URL=${STREAM_URL}
AIRBRIDGE_ADMIN_USER=admin
AIRBRIDGE_ADMIN_PASSWORD=${ADMIN_PASSWORD}
AIRBRIDGE_SESSION_TTL_SECONDS=28800
AIRBRIDGE_AUTH_RATE_LIMIT=12
AIRBRIDGE_ALEXA_INVOKE_MODE=alexa_remote2
AIRBRIDGE_ALEXA_INIT_TIMEOUT_SECONDS=60
AIRBRIDGE_ALEXA_INVOCATION_PREFIX=open air bridge and play token
AIRBRIDGE_ALEXA_SKILL_INVOCATION_NAME=air bridge
AIRBRIDGE_ALEXA_INVOCATION_PREFIX_FALLBACKS=
AIRBRIDGE_ALEXA_SKILL_INVOKE_TIMEOUT_SECONDS=6
AIRBRIDGE_ALEXA_SKILL_INVOKE_RETRY_COUNT=2
AIRBRIDGE_SKILL_APP_ID=
AIRBRIDGE_ALEXA_COOKIE_PATH=/etc/airbridge/alexa-cookie.txt
AIRBRIDGE_SHAIRPORT_BIN=/usr/bin/shairport-sync
AIRBRIDGE_FFMPEG_BIN=/usr/bin/ffmpeg
AIRBRIDGE_FFMPEG_BITRATE=192k
AIRBRIDGE_SPAWN_PROCESSES=true
AIRBRIDGE_HLS_SEGMENT_SECONDS=2
AIRBRIDGE_HLS_LIST_SIZE=6
AIRBRIDGE_MONITOR_INTERVAL_MS=2000
AIRBRIDGE_DATA_ROOT=/var/lib/airbridge
AIRBRIDGE_RUN_ROOT=/run/airbridge
AIRBRIDGE_HLS_ROOT=/var/lib/airbridge/hls
AIRBRIDGE_DB_PATH=/var/lib/airbridge/db/airbridge.sqlite
AIRBRIDGE_SETUP_ENV_FILE=/etc/airbridge/airbridge.env
AIRBRIDGE_SETUP_CLOUDFLARED_FILE=/etc/airbridge/cloudflared.yml
AIRBRIDGE_SETUP_ALEXA_COOKIE_FILE=/etc/airbridge/alexa-cookie.txt
AIRBRIDGE_SETUP_ALEXA_COOKIE_ENCRYPTED_FILE=/etc/credstore.encrypted/airbridge_alexa_cookie
AIRBRIDGE_SERVICE_NAME=airbridge.service
AIRBRIDGE_CLOUDFLARED_SERVICE_NAME=cloudflared-airbridge.service
AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION=false
AIRBRIDGE_ALEXA_COOKIE_WIZARD_PROXY_PORT=3457
AIRBRIDGE_ALEXA_COOKIE_WIZARD_TIMEOUT_SECONDS=600
AIRBRIDGE_ALEXA_COOKIE_WIZARD_MOCK=false
ENV

else
  ADMIN_PASSWORD="(bereits gesetzt – in ${ENV_FILE} nachschlagen oder Passwort in Web-UI aendern)"
  echo "Keeping existing ${ENV_FILE}"
fi

# Keep default installation mode simple and always bootable without systemd credentials.
upsert_env "AIRBRIDGE_ALEXA_COOKIE_PATH" "${PLAIN_COOKIE_FILE}" "${ENV_FILE}"
upsert_env "AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION" "false" "${ENV_FILE}"

if [[ ! -f "${CLOUDFLARED_FILE}" ]]; then
  cp deploy/cloudflared/config.yml.template "${CLOUDFLARED_FILE}"
fi

if [[ ! -f "${PLAIN_COOKIE_FILE}" ]]; then
  touch "${PLAIN_COOKIE_FILE}"
fi

chown root:"${APP_GROUP}" "${ENV_FILE}" "${CLOUDFLARED_FILE}" "${PLAIN_COOKIE_FILE}" || true
chmod 0660 "${ENV_FILE}" "${CLOUDFLARED_FILE}" "${PLAIN_COOKIE_FILE}" || true

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
echo "  Cookie-Datei:   ${PLAIN_COOKIE_FILE}"
echo ""
echo "Naechste Schritte:"
echo ""
echo "  1) Browser oeffnen: http://${HOST_IP}:3000"
echo "     Login mit: admin / ${ADMIN_PASSWORD}"
echo ""
echo "  2) System Setup -> Stream-URL pruefen/setzen:"
if [[ -n "${STREAM_URL_INPUT}" ]]; then
  echo "     (bereits gesetzt: ${STREAM_URL_INPUT})"
else
  echo "     Cloudflared-Tunnel-URL eintragen (z.B. https://stream.deinedomain.com)"
fi
echo ""
echo "  3) System Setup -> Alexa Cookie Wizard starten"
echo "     Amazon-Login im Browser abschliessen"
echo ""
echo "  4) 'Aenderungen anwenden (AirBridge Neustart)' klicken"
echo ""
echo "  5) Targets -> 'Alexa Geraete importieren'"
echo "     Beide Echo-Geraete als Targets aktivieren"
echo ""
if [[ "${CLOUDFLARED_INSTALLED}" == "true" ]]; then
  echo "  Optional Cloudflared starten:"
  echo "    systemctl enable --now cloudflared-airbridge.service"
  echo ""
  if [[ -n "${SKILL_URL_INPUT}" ]]; then
    echo "  Alexa Skill Endpoint: ${SKILL_URL_INPUT}/alexa/skill"
    echo ""
  fi
fi
echo "  Logs verfolgen: journalctl -fu airbridge.service"
echo "============================================================"
