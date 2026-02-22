#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/alexa-cookie.txt" >&2
  exit 1
fi

SOURCE_FILE="$1"
TARGET_FILE="/etc/credstore.encrypted/airbridge_alexa_cookie"

if [[ ! -f "${SOURCE_FILE}" ]]; then
  echo "Cookie file not found: ${SOURCE_FILE}" >&2
  exit 1
fi

install -d -m 0750 /etc/credstore.encrypted
systemd-creds encrypt --name=airbridge_alexa_cookie "${SOURCE_FILE}" "${TARGET_FILE}"
chmod 0640 "${TARGET_FILE}"

echo "Encrypted credential written to ${TARGET_FILE}"
