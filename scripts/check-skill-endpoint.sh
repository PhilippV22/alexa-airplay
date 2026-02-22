#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  check-skill-endpoint.sh --url <https://skill.example.org/alexa/skill> [--app-id <amzn1.ask.skill...>] [--timeout-seconds <N>]

Examples:
  check-skill-endpoint.sh --url https://skill.example.org/alexa/skill
  check-skill-endpoint.sh --url https://skill.example.org/alexa/skill --app-id amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
USAGE
}

URL=""
APP_ID=""
TIMEOUT_SECONDS="15"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      URL="${2:-}"
      shift 2
      ;;
    --app-id)
      APP_ID="${2:-}"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${URL}" ]]; then
  echo "Missing required --url" >&2
  usage >&2
  exit 1
fi

if ! [[ "${TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] || [[ "${TIMEOUT_SECONDS}" -le 0 ]]; then
  echo "--timeout-seconds must be a positive integer" >&2
  exit 1
fi

TMP_BODY="$(mktemp)"
TMP_RESPONSE="$(mktemp)"
trap 'rm -f "${TMP_BODY}" "${TMP_RESPONSE}"' EXIT

if [[ -n "${APP_ID}" ]]; then
  cat > "${TMP_BODY}" <<JSON
{
  "session": {
    "application": {
      "applicationId": "${APP_ID}"
    }
  },
  "request": {
    "type": "LaunchRequest"
  }
}
JSON
else
  cat > "${TMP_BODY}" <<'JSON'
{
  "request": {
    "type": "LaunchRequest"
  }
}
JSON
fi

HTTP_CODE="$(
  curl -sS \
    --max-time "${TIMEOUT_SECONDS}" \
    -o "${TMP_RESPONSE}" \
    -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -X POST "${URL}" \
    --data-binary "@${TMP_BODY}"
)"

echo "HTTP status: ${HTTP_CODE}"
echo "Response body:"
cat "${TMP_RESPONSE}"
echo ""

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "Endpoint check failed: expected HTTP 200." >&2
  exit 1
fi

if ! grep -q '"version"[[:space:]]*:[[:space:]]*"1.0"' "${TMP_RESPONSE}"; then
  echo 'Endpoint check failed: response does not look like Alexa response (missing "version":"1.0").' >&2
  exit 1
fi

echo "Endpoint check passed."
