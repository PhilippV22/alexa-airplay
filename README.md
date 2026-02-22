# AirBridge Core

AirBridge Core ist ein Debian/Linux-Dienst, der pro Alexa-Ziel einen eigenen AirPlay-Endpunkt bereitstellt und Audio ueber Alexa-API-Flow auf Echo-Geraete bringt.

## Wichtige Limits (MVP)

- Native Alexa-Gruppenwiedergabe ist im Consumer-Setup nicht verfuegbar.
- Gruppen-Targets werden gespeichert, Aktivierung liefert immer `409 GROUP_NATIVE_UNSUPPORTED`.
- AudioPlayer braucht HTTPS mit public-trust Zertifikat.

## Neu: Vollstaendige Web-UI Einrichtung

Die Web-UI kann jetzt das komplette Setup erledigen:

- Basis-Konfiguration (`airbridge.env`) bearbeiten
- Admin-Passwort (Argon2id Hash) setzen
- Alexa-Cookie Wizard: Amazon Login automatisch ueber Proxy-Flow erfassen
- Alexa-Cookie manueller Fallback als Textfeld
- Cloudflared-Konfiguration bearbeiten
- AirBridge-Neustart direkt aus der Web-UI anstossen
- Targets/Sessions/Audit weiterhin komplett verwalten

## Architektur

- `shairport-sync` pro aktivem Device-Target
- `ffmpeg` pro aktivem Device-Target (PCM -> HLS)
- Node.js Core fuer API, Web-UI, Skill-Endpoint
- SQLite fuer `targets`, `sessions`, `audit_log`
- optional `cloudflared` fuer oeffentliche TLS-Hosts

## Lokaler Start

```bash
cp .env.example .env
npm install
npm run dev
```

## Build und Tests

```bash
npm run lint
npm test
npm run build
```

## Systeminstallation (Debian/Ubuntu)

```bash
sudo ./scripts/install-debian.sh
```

Was das Script macht:

- installiert Pflichtpakete (Node.js 22, ffmpeg, shairport-sync)
- versucht optional `cloudflared` zu installieren, falls in apt verfuegbar
- nutzt `npm ci` und faellt bei Lockfile-Problemen automatisch auf `npm install` zurueck
- deployed nach `/opt/airbridge`
- legt User/Group `airbridge` an
- erzeugt `/etc/airbridge/airbridge.env` mit sicheren Defaults
- installiert systemd Units
- startet `airbridge.service` + `airbridge-watchdog.timer`

Nach dem Install:

1. Web-UI aufrufen: `http://<host>:3000`
2. Mit generiertem Admin-Passwort aus Script-Output einloggen
3. Unter `System Setup` Stream-URL setzen
4. `Alexa Cookie Wizard` starten und Amazon Login im Wizard-Fenster abschliessen
5. Optional Cloudflared konfigurieren
6. `Aenderungen anwenden (AirBridge Neustart)` klicken

Optional Cloudflared starten (nur falls installiert):

```bash
sudo systemctl enable --now cloudflared-airbridge.service
```

## Alexa Skill Setup

- Interaction Model: `deploy/ask/interaction-model.json`
- Skill Endpoint: `https://skill.<deine-domain>/alexa/skill`
- Optional App-ID-Pruefung: `AIRBRIDGE_SKILL_APP_ID`

## REST API

Auth:

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Setup:

- `GET /api/setup/status`
- `GET /api/setup/config`
- `PUT /api/setup/config`
- `POST /api/setup/admin-password`
- `POST /api/setup/alexa-cookie`
- `POST /api/setup/alexa-cookie/wizard/start`
- `GET /api/setup/alexa-cookie/wizard/status`
- `POST /api/setup/alexa-cookie/wizard/stop`
- `PUT /api/setup/cloudflared`
- `POST /api/setup/apply` (`{"restart": true}`)

Runtime:

- `GET /api/targets`
- `POST /api/targets`
- `PATCH /api/targets/:id`
- `DELETE /api/targets/:id`
- `POST /api/targets/:id/reconcile`
- `GET /api/sessions`
- `GET /api/audit`
- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

## Verzeichnisse

- App: `/opt/airbridge`
- Env: `/etc/airbridge/airbridge.env`
- Cloudflared Config: `/etc/airbridge/cloudflared.yml`
- Alexa Cookie (Default): `/etc/airbridge/alexa-cookie.txt`
- DB: `/var/lib/airbridge/db/airbridge.sqlite`
- HLS: `/var/lib/airbridge/hls/<target-id>/`
- FIFO: `/run/airbridge/fifo/<target-id>.pcm`

## Hinweis zu Alexa

`alexa-remote2` ist inoffiziell. Fehler werden in Session-State und Audit sichtbar gemacht.
