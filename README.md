# AirBridge Core

AirBridge Core ist ein Linux-Dienst (Debian 12+), der pro Alexa-Ziel einen separaten AirPlay-Empfänger bereitstellt und eingehendes Audio per Alexa-API-Flow auf Echo-Geräten startet.

## Wichtige Grenzen (MVP)

- Native Alexa-Gruppenwiedergabe wird im Consumer-Setup nicht unterstützt.
- Gruppen-Targets werden gespeichert, aber Aktivierung wird mit `409 GROUP_NATIVE_UNSUPPORTED` blockiert.
- Für Alexa AudioPlayer werden öffentlich vertrauenswürdige TLS-Endpunkte benötigt.

## Architektur

- `shairport-sync` pro aktivem Device-Target (AirPlay Input)
- `ffmpeg` pro aktivem Device-Target (PCM -> HLS)
- Node.js Core (`src/server.ts`) für API, UI, Skill-Endpoint, Session/Audit/DB
- SQLite für `targets`, `sessions`, `audit_log`
- optional `cloudflared` für public-trust TLS Hostnames

## Features

- Passwortgeschützte Web-UI
- REST API für Targets/Sessions/Audit
- Health Endpoints (`/health/live`, `/health/ready`)
- Prometheus Metrics (`/metrics`)
- Audit Logging für Admin- und Alexa-Aktionen
- systemd Units + Watchdog Timer

## Lokaler Start

```bash
cp .env.example .env
# Mindestwerte anpassen: AIRBRIDGE_STREAM_BASE_URL, AIRBRIDGE_SESSION_SECRET, AIRBRIDGE_ADMIN_PASSWORD
npm install
npm run dev
```

Default Login: `admin` mit Passwort aus `AIRBRIDGE_ADMIN_PASSWORD`.

## Build und Tests

```bash
npm run lint
npm test
npm run build
```

## Produktionsinstallation (Debian)

```bash
sudo ./scripts/install-debian.sh
```

Danach:

1. `/etc/airbridge/airbridge.env` konfigurieren
2. Alexa-Cookie verschlüsseln:
   ```bash
   sudo ./scripts/encrypt-cookie.sh /path/to/alexa-cookie.txt
   ```
3. Cloudflared Tunnel konfigurieren: `/etc/airbridge/cloudflared.yml`
4. Dienste starten:
   ```bash
   sudo systemctl start airbridge.service
   sudo systemctl enable --now airbridge-watchdog.timer
   # optional:
   sudo systemctl enable --now cloudflared-airbridge.service
   ```

## Alexa Skill Setup

- Interaction Model: `deploy/ask/interaction-model.json`
- HTTPS Endpoint der Skill auf `https://skill.<deine-domain>/alexa/skill` setzen
- Optional `AIRBRIDGE_SKILL_APP_ID` setzen, damit App-ID geprüft wird

## REST API

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/targets`
- `POST /api/targets`
- `PATCH /api/targets/:id`
- `DELETE /api/targets/:id`
- `POST /api/targets/:id/reconcile`
- `GET /api/sessions`
- `GET /api/audit`

### Beispiel: Device Target anlegen

```bash
curl -sS -X POST http://127.0.0.1:3000/api/targets \
  -H 'Content-Type: application/json' \
  -H 'Cookie: airbridge_session=<cookie>' \
  -d '{
    "name": "Wohnzimmer Echo",
    "type": "device",
    "alexa_device_id": "A3XXXXXXXXXXXX",
    "enabled": true
  }'
```

### Beispiel: Gruppenaktivierung (erwarteter Fehler)

```bash
curl -sS -X PATCH http://127.0.0.1:3000/api/targets/4 \
  -H 'Content-Type: application/json' \
  -H 'Cookie: airbridge_session=<cookie>' \
  -d '{"enabled": true}'
```

Antwort: `409 GROUP_NATIVE_UNSUPPORTED`

## Verzeichnisse

- DB: `/var/lib/airbridge/db/airbridge.sqlite`
- HLS: `/var/lib/airbridge/hls/<target-id>/`
- FIFO: `/run/airbridge/fifo/<target-id>.pcm`

## Hinweise zur Alexa-Anbindung

`alexa-remote2` ist inoffiziell. Das Projekt behandelt den Adapter als fragil und protokolliert Fehler in Audit + Session-State.

