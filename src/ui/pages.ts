export function loginPageHtml(): string {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AirBridge Login</title>
  <style>
    :root {
      font-family: "Source Sans 3", "Segoe UI", sans-serif;
      color-scheme: light;
      --bg: #f4f7fb;
      --card: #ffffff;
      --text: #0b1829;
      --muted: #5b6b80;
      --accent: #0d9488;
      --danger: #b91c1c;
      --border: #d9e2ec;
    }
    body { margin: 0; background: radial-gradient(circle at top, #d7efe9 0%, var(--bg) 52%); color: var(--text); }
    main {
      max-width: 420px;
      margin: 11vh auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      box-shadow: 0 16px 40px rgba(10, 20, 35, 0.12);
    }
    h1 { margin: 0 0 14px; font-size: 1.45rem; }
    p { margin: 0 0 18px; color: var(--muted); }
    label { display: block; margin-bottom: 12px; }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 9px;
      font-size: 0.95rem;
      background: #fff;
    }
    button {
      width: 100%;
      border: 0;
      background: var(--accent);
      color: #fff;
      border-radius: 9px;
      padding: 10px 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .error { min-height: 1.2rem; color: var(--danger); margin-top: 10px; }
  </style>
</head>
<body>
  <main>
    <h1>AirBridge Setup</h1>
    <p>Anmeldung fuer Verwaltung und Systemeinrichtung.</p>
    <form id="login-form">
      <label>
        Benutzer
        <input name="username" value="admin" required />
      </label>
      <label>
        Passwort
        <input name="password" type="password" required />
      </label>
      <button type="submit">Einloggen</button>
      <p class="error" id="error"></p>
    </form>
  </main>
  <script>
    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('error');

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      errorEl.textContent = '';

      const data = new FormData(form);
      const payload = {
        username: data.get('username'),
        password: data.get('password')
      };

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const body = await res.json().catch(function () { return {}; });
        errorEl.textContent = body.message || 'Login fehlgeschlagen';
        return;
      }

      window.location.href = '/';
    });
  </script>
</body>
</html>`;
}

export function mainPageHtml(adminUser: string): string {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AirBridge Control</title>
  <style>
    :root {
      font-family: "Source Sans 3", "Segoe UI", sans-serif;
      --bg: #0e1a2b;
      --bg-soft: #13233a;
      --card: #14263e;
      --card-2: #182f4d;
      --text: #e8f2ff;
      --muted: #9fb4cc;
      --accent: #0ea5a0;
      --accent-2: #0284c7;
      --danger: #f87171;
      --ok: #86efac;
      --border: #284565;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #0a1322 0%, var(--bg) 100%); color: var(--text); }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(10, 19, 34, 0.92);
      backdrop-filter: blur(6px);
    }
    header h1 { margin: 0; font-size: 1.08rem; letter-spacing: 0.02em; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .pill {
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      font-size: 0.82rem;
    }
    main {
      padding: 14px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 12px;
      align-items: start;
    }
    section {
      background: linear-gradient(180deg, var(--card) 0%, var(--bg-soft) 100%);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    h2 { margin: 0 0 10px; font-size: 0.98rem; }
    h3 { margin: 10px 0 8px; font-size: 0.88rem; color: var(--muted); }
    label {
      display: grid;
      gap: 4px;
      font-size: 0.8rem;
      color: var(--muted);
      min-width: 180px;
      flex: 1 1 180px;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      background: #0c1a2d;
      color: var(--text);
      font-size: 0.88rem;
    }
    textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, monospace; }
    input[type="checkbox"] { width: auto; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--accent-2);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary { background: #2c4d77; }
    button.success { background: var(--accent); }
    button.danger { background: #b42335; }
    table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
    th, td { text-align: left; border-bottom: 1px solid #203954; padding: 6px 4px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .msg { min-height: 1.2rem; font-size: 0.82rem; color: var(--muted); margin-top: 8px; }
    .msg.err { color: var(--danger); }
    .msg.ok { color: var(--ok); }
    .status-grid {
      display: grid;
      gap: 6px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-bottom: 8px;
    }
    .status-item {
      padding: 8px;
      border-radius: 8px;
      border: 1px solid #245079;
      background: rgba(5, 17, 30, 0.45);
      font-size: 0.8rem;
    }
    .status-item b { color: var(--text); display: block; font-size: 0.77rem; margin-bottom: 3px; }
    .target-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <header>
    <h1>AirBridge Web Control</h1>
    <div class="row">
      <span class="pill">${adminUser}</span>
      <button class="secondary" id="reload-all">Neu laden</button>
      <button class="danger" id="logout">Logout</button>
    </div>
  </header>

  <main>
    <section style="grid-column: 1 / -1;">
      <h2>System Setup</h2>
      <div class="status-grid" id="setup-status"></div>
      <div class="row" style="margin-bottom: 8px;">
        <button class="secondary" id="refresh-setup">Setup Status aktualisieren</button>
        <button class="success" id="apply-restart">Aenderungen anwenden (AirBridge Neustart)</button>
      </div>
      <p class="msg" id="setup-message"></p>

      <h3>Basis Konfiguration</h3>
      <div class="row">
        <label>Stream Base URL
          <input id="cfg-stream-base" placeholder="https://stream.airbridge.example.com" />
        </label>
        <label>Bind Host
          <input id="cfg-bind-host" placeholder="0.0.0.0" />
        </label>
        <label>Port
          <input id="cfg-port" placeholder="3000" />
        </label>
        <label>Alexa Invoke Mode
          <select id="cfg-alexa-mode">
            <option value="mock">mock</option>
            <option value="alexa_remote2">alexa_remote2</option>
          </select>
        </label>
        <label>Alexa Init Timeout (Sek.)
          <input id="cfg-alexa-init-timeout" placeholder="60" />
        </label>
        <label>Alexa Invocation Prefix
          <input id="cfg-alexa-prefix" placeholder="ask air bridge to play token" />
        </label>
        <label>Session Secret
          <input id="cfg-session-secret" placeholder="long random secret" />
        </label>
        <label>Admin User
          <input id="cfg-admin-user" placeholder="admin" />
        </label>
        <label>FFmpeg Bitrate
          <input id="cfg-ffmpeg-bitrate" placeholder="192k" />
        </label>
        <label>Shairport Binary
          <input id="cfg-shairport-bin" placeholder="/usr/bin/shairport-sync" />
        </label>
        <label>FFmpeg Binary
          <input id="cfg-ffmpeg-bin" placeholder="/usr/bin/ffmpeg" />
        </label>
      </div>
      <div class="row" style="margin-top: 8px;">
        <label style="display:flex; align-items:center; gap:8px; min-width:auto; color:var(--text);">
          <input type="checkbox" id="cfg-trust-proxy" /> Trust proxy
        </label>
        <label style="display:flex; align-items:center; gap:8px; min-width:auto; color:var(--text);">
          <input type="checkbox" id="cfg-spawn-processes" /> Shairport/FFmpeg Prozesse starten
        </label>
        <button class="success" id="save-config">Konfiguration speichern</button>
      </div>
      <p class="msg" id="config-message"></p>

      <h3>Admin Passwort</h3>
      <div class="row">
        <label>Neues Passwort (mind. 8 Zeichen)
          <input id="new-admin-password" type="password" />
        </label>
        <button class="success" id="save-admin-password">Passwort speichern</button>
      </div>
      <p class="msg" id="password-message"></p>

      <h3>Alexa Cookie Wizard (Automatisch)</h3>
      <div class="row">
        <label>Amazon Region Domain
          <select id="alexa-wizard-amazon-page">
            <option value="amazon.de">amazon.de</option>
            <option value="amazon.com">amazon.com</option>
            <option value="amazon.co.uk">amazon.co.uk</option>
            <option value="amazon.fr">amazon.fr</option>
            <option value="amazon.it">amazon.it</option>
            <option value="amazon.es">amazon.es</option>
            <option value="amazon.co.jp">amazon.co.jp</option>
          </select>
        </label>
        <label>Proxy Host (wie im Browser aufgerufen)
          <input id="alexa-wizard-proxy-host" placeholder="192.168.1.10" />
        </label>
        <label>Proxy Port
          <input id="alexa-wizard-proxy-port" value="3457" />
        </label>
      </div>
      <div class="row" style="margin-top:8px;">
        <button class="success" id="start-alexa-wizard">Wizard starten</button>
        <button class="secondary" id="refresh-alexa-wizard">Wizard Status</button>
        <button class="danger" id="stop-alexa-wizard">Wizard stoppen</button>
      </div>
      <p class="msg" id="alexa-wizard-message"></p>
      <div class="status-item" id="alexa-wizard-status">Kein Wizard aktiv.</div>

      <h3>Alexa Cookie (manueller Fallback)</h3>
      <label>
        Cookie Inhalt
        <textarea id="alexa-cookie" placeholder="Alexa Session Cookie hier einfuegen"></textarea>
      </label>
      <div class="row">
        <button class="success" id="save-cookie">Cookie speichern</button>
      </div>
      <p class="msg" id="cookie-message"></p>

      <h3>Cloudflared Konfiguration</h3>
      <label>
        /etc/airbridge/cloudflared.yml
        <textarea id="cloudflared-config" placeholder="tunnel: ..."></textarea>
      </label>
      <div class="row">
        <button class="secondary" id="save-cloudflared">Cloudflared Konfiguration speichern</button>
      </div>
      <p class="msg" id="cloudflared-message"></p>
    </section>

    <section>
      <h2>Target anlegen</h2>
      <div class="row">
        <label>Name
          <input id="name" placeholder="Wohnzimmer Echo" />
        </label>
        <label>Type
          <select id="type">
            <option value="device">device</option>
            <option value="group">group</option>
          </select>
        </label>
        <label>alexa_device_id
          <input id="deviceId" placeholder="A3XXXXXXXXXXXX" />
        </label>
        <label>alexa_group_id
          <input id="groupId" placeholder="amzn1.alexa.group..." />
        </label>
      </div>
      <div class="row" style="margin-top:8px;">
        <button id="create">Target erstellen</button>
      </div>
      <p class="msg" id="create-error"></p>
    </section>

    <section style="grid-column: 1 / -1;">
      <h2>Targets</h2>
      <div class="row" style="margin-bottom: 8px;">
        <button class="success" id="import-alexa-devices">Alexa Devices importieren</button>
      </div>
      <p class="msg" id="import-message"></p>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>Type</th><th>AirPlay</th><th>Status</th><th>Enabled</th><th>Aktion</th>
          </tr>
        </thead>
        <tbody id="targets"></tbody>
      </table>
    </section>

    <section>
      <h2>Sessions</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Target</th><th>State</th><th>URL</th><th>Start</th><th>Ende</th></tr>
        </thead>
        <tbody id="sessions"></tbody>
      </table>
    </section>

    <section>
      <h2>Audit</h2>
      <table>
        <thead>
          <tr><th>Zeit</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th><th>Details</th></tr>
        </thead>
        <tbody id="audit"></tbody>
      </table>
    </section>
  </main>

  <script>
    var setupKeyMap = {
      AIRBRIDGE_STREAM_BASE_URL: 'cfg-stream-base',
      AIRBRIDGE_BIND_HOST: 'cfg-bind-host',
      AIRBRIDGE_PORT: 'cfg-port',
      AIRBRIDGE_ALEXA_INVOKE_MODE: 'cfg-alexa-mode',
      AIRBRIDGE_ALEXA_INIT_TIMEOUT_SECONDS: 'cfg-alexa-init-timeout',
      AIRBRIDGE_ALEXA_INVOCATION_PREFIX: 'cfg-alexa-prefix',
      AIRBRIDGE_SESSION_SECRET: 'cfg-session-secret',
      AIRBRIDGE_ADMIN_USER: 'cfg-admin-user',
      AIRBRIDGE_FFMPEG_BITRATE: 'cfg-ffmpeg-bitrate',
      AIRBRIDGE_SHAIRPORT_BIN: 'cfg-shairport-bin',
      AIRBRIDGE_FFMPEG_BIN: 'cfg-ffmpeg-bin'
    };
    var alexaWizardPollTimer = null;
    var alexaAutoImportAttempted = false;
    var alexaImportInFlight = false;

    function setMessage(id, text, isError, isSuccess) {
      var el = document.getElementById(id);
      if (!el) {
        return;
      }
      el.textContent = text || '';
      el.classList.remove('err');
      el.classList.remove('ok');
      if (isError) {
        el.classList.add('err');
      }
      if (isSuccess) {
        el.classList.add('ok');
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function parseBool(value) {
      return ['1', 'true', 'yes', 'on'].indexOf(String(value || '').toLowerCase()) >= 0;
    }

    async function api(path, opts) {
      var res = await fetch(path, Object.assign({
        headers: { 'Content-Type': 'application/json' }
      }, opts || {}));

      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('unauthorized');
      }

      return res;
    }

    async function loadSetup() {
      setMessage('setup-message', 'Lade Setup Status ...');
      var statusRes = await api('/api/setup/status');
      var configRes = await api('/api/setup/config');
      var statusBody = await statusRes.json();
      var configBody = await configRes.json();

      renderSetupStatus(statusBody.status);
      fillSetupConfig(configBody.values || {});
      document.getElementById('cloudflared-config').value = configBody.cloudflaredConfig || '';

      if (!document.getElementById('alexa-wizard-proxy-host').value) {
        document.getElementById('alexa-wizard-proxy-host').value = window.location.hostname;
      }

      await refreshAlexaWizardStatus();
      setMessage('setup-message', 'Setup geladen.', false, true);
    }

    function renderSetupStatus(status) {
      var el = document.getElementById('setup-status');
      el.innerHTML = '';

      var items = [
        ['ENV File', status.envFileExists ? 'vorhanden' : 'fehlt'],
        ['ENV write', status.envWritable ? 'ok' : 'kein Zugriff'],
        ['Cloudflared File', status.cloudflaredConfigExists ? 'vorhanden' : 'fehlt'],
        ['Cloudflared write', status.cloudflaredWritable ? 'ok' : 'kein Zugriff'],
        ['Cookie encrypted', status.encryptedCookieExists ? 'vorhanden' : 'fehlt'],
        ['Cookie plain', status.plainCookieExists ? 'vorhanden' : 'fehlt'],
        ['Admin Hash', status.hasAdminPasswordHash ? 'gesetzt' : 'fehlt'],
        ['Session Secret', status.hasSessionSecret ? 'gesetzt' : 'fehlt'],
        ['AirBridge Service', status.services.airbridge.active + ' / ' + status.services.airbridge.enabled],
        ['Cloudflared Service', status.services.cloudflared.active + ' / ' + status.services.cloudflared.enabled],
        ['Encrypt erlaubt', status.allowCredentialEncryption ? 'ja' : 'nein']
      ];

      for (var i = 0; i < items.length; i += 1) {
        var card = document.createElement('div');
        card.className = 'status-item';
        card.innerHTML = '<b>' + escapeHtml(items[i][0]) + '</b>' + escapeHtml(items[i][1]);
        el.appendChild(card);
      }
    }

    function fillSetupConfig(values) {
      var keys = Object.keys(setupKeyMap);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        var id = setupKeyMap[key];
        var input = document.getElementById(id);
        if (input) {
          input.value = values[key] || '';
        }
      }

      document.getElementById('cfg-trust-proxy').checked = parseBool(values.AIRBRIDGE_TRUST_PROXY);
      document.getElementById('cfg-spawn-processes').checked = parseBool(values.AIRBRIDGE_SPAWN_PROCESSES);
    }

    function collectSetupConfig() {
      var values = {};
      var keys = Object.keys(setupKeyMap);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        var id = setupKeyMap[key];
        values[key] = document.getElementById(id).value.trim();
      }

      values.AIRBRIDGE_TRUST_PROXY = document.getElementById('cfg-trust-proxy').checked;
      values.AIRBRIDGE_SPAWN_PROCESSES = document.getElementById('cfg-spawn-processes').checked;
      values.AIRBRIDGE_SETUP_ALLOW_CREDENTIAL_ENCRYPTION = false;
      return values;
    }

    async function saveSetupConfig() {
      setMessage('config-message', 'Speichere Konfiguration ...');
      var res = await api('/api/setup/config', {
        method: 'PUT',
        body: JSON.stringify({ values: collectSetupConfig() })
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        setMessage('config-message', body.message || 'Fehler beim Speichern', true, false);
        return;
      }

      setMessage('config-message', 'Konfiguration gespeichert.', false, true);
      await loadSetup();
    }

    async function saveAdminPassword() {
      var input = document.getElementById('new-admin-password');
      var password = input.value;
      if (!password || password.length < 8) {
        setMessage('password-message', 'Passwort muss mind. 8 Zeichen haben.', true, false);
        return;
      }

      setMessage('password-message', 'Speichere Passwort ...');
      var res = await api('/api/setup/admin-password', {
        method: 'POST',
        body: JSON.stringify({ password: password })
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        setMessage('password-message', body.message || 'Fehler beim Speichern', true, false);
        return;
      }

      input.value = '';
      setMessage('password-message', 'Passwort gespeichert. Danach Neustart ausfuehren.', false, true);
      await loadSetup();
    }

    async function saveAlexaCookie() {
      var cookie = document.getElementById('alexa-cookie').value;
      if (!cookie.trim()) {
        setMessage('cookie-message', 'Cookie darf nicht leer sein.', true, false);
        return;
      }

      setMessage('cookie-message', 'Speichere Cookie ...');
      var res = await api('/api/setup/alexa-cookie', {
        method: 'POST',
        body: JSON.stringify({
          cookie: cookie,
          preferEncrypted: false
        })
      });

      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        setMessage('cookie-message', body.message || 'Cookie konnte nicht gespeichert werden', true, false);
        return;
      }

      document.getElementById('alexa-cookie').value = '';
      setMessage('cookie-message', 'Cookie gespeichert (' + body.result.mode + '). Danach Neustart ausfuehren.', false, true);
      await loadSetup();
    }

    function stopAlexaWizardPolling() {
      if (alexaWizardPollTimer) {
        clearInterval(alexaWizardPollTimer);
        alexaWizardPollTimer = null;
      }
    }

    function renderAlexaWizardState(state) {
      var statusEl = document.getElementById('alexa-wizard-status');
      var statusText = 'Status: ' + (state.status || 'unknown');
      if (state.message) {
        statusText += ' | ' + state.message;
      }
      if (state.error) {
        statusText += ' | Error: ' + state.error;
      }
      if (state.loginUrl) {
        statusText += ' | Login URL: ' + state.loginUrl;
      }
      statusEl.textContent = statusText;
    }

    async function refreshAlexaWizardStatus() {
      var res = await api('/api/setup/alexa-cookie/wizard/status');
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return {}; });
        setMessage('alexa-wizard-message', errBody.message || 'Wizard Status konnte nicht geladen werden', true, false);
        return;
      }

      var body = await res.json();
      var state = body.state || {};
      renderAlexaWizardState(state);

      if (state.status === 'awaiting_login' && state.loginUrl) {
        setMessage('alexa-wizard-message', 'Amazon Login in neuem Tab oeffnen und anmelden. Cookie wird automatisch gespeichert.', false, true);
      } else if (state.status === 'completed') {
        setMessage('alexa-wizard-message', state.message || 'Cookie automatisch gespeichert. Bitte AirBridge neu starten.', false, true);
      } else if (state.status === 'failed') {
        setMessage('alexa-wizard-message', state.error || state.message || 'Wizard fehlgeschlagen', true, false);
      } else if (state.status === 'stopped') {
        setMessage('alexa-wizard-message', state.message || 'Wizard gestoppt.', false, true);
      } else if (state.status === 'starting') {
        setMessage('alexa-wizard-message', 'Wizard startet ...', false, false);
      }

      if (state.status === 'completed' || state.status === 'failed' || state.status === 'stopped' || state.status === 'idle') {
        stopAlexaWizardPolling();
        if (state.status === 'completed') {
          await loadSetup();
        }
      }
    }

    function startAlexaWizardPolling() {
      stopAlexaWizardPolling();
      alexaWizardPollTimer = setInterval(function () {
        refreshAlexaWizardStatus().catch(function () {});
      }, 2000);
    }

    function defaultBaseAmazonPage(amazonPage) {
      if (amazonPage === 'amazon.co.jp') {
        return 'amazon.co.jp';
      }
      return 'amazon.com';
    }

    function defaultLanguage(amazonPage) {
      if (amazonPage === 'amazon.de') return 'de-DE';
      if (amazonPage === 'amazon.co.uk') return 'en-GB';
      if (amazonPage === 'amazon.fr') return 'fr-FR';
      if (amazonPage === 'amazon.it') return 'it-IT';
      if (amazonPage === 'amazon.es') return 'es-ES';
      if (amazonPage === 'amazon.co.jp') return 'ja-JP';
      return 'en-US';
    }

    async function startAlexaWizard() {
      var amazonPage = document.getElementById('alexa-wizard-amazon-page').value;
      var proxyHostInput = document.getElementById('alexa-wizard-proxy-host').value.trim();
      var proxyPortInput = document.getElementById('alexa-wizard-proxy-port').value.trim();
      var proxyPort = Number.parseInt(proxyPortInput || '3457', 10);
      if (Number.isNaN(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        setMessage('alexa-wizard-message', 'Proxy Port ist ungueltig.', true, false);
        return;
      }

      setMessage('alexa-wizard-message', 'Starte Wizard ...');
      var res = await api('/api/setup/alexa-cookie/wizard/start', {
        method: 'POST',
        body: JSON.stringify({
          amazonPage: amazonPage,
          baseAmazonPage: defaultBaseAmazonPage(amazonPage),
          acceptLanguage: defaultLanguage(amazonPage),
          proxyHost: proxyHostInput || undefined,
          proxyPort: proxyPort,
          preferEncrypted: false
        })
      });

      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        setMessage('alexa-wizard-message', body.message || 'Wizard konnte nicht gestartet werden', true, false);
        return;
      }

      renderAlexaWizardState(body.state || {});
      setMessage('alexa-wizard-message', 'Wizard gestartet. Login-Fenster wird geoeffnet ...', false, true);

      var loginUrl = body.state && body.state.loginUrl;
      if (loginUrl) {
        window.open(loginUrl, '_blank', 'noopener,noreferrer');
      }

      startAlexaWizardPolling();
      await refreshAlexaWizardStatus();
    }

    async function stopAlexaWizard() {
      var res = await api('/api/setup/alexa-cookie/wizard/stop', {
        method: 'POST',
        body: JSON.stringify({})
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        setMessage('alexa-wizard-message', body.message || 'Wizard konnte nicht gestoppt werden', true, false);
        return;
      }
      stopAlexaWizardPolling();
      renderAlexaWizardState(body.state || {});
      setMessage('alexa-wizard-message', 'Wizard gestoppt.', false, true);
    }

    async function saveCloudflaredConfig() {
      var content = document.getElementById('cloudflared-config').value;
      if (!content.trim()) {
        setMessage('cloudflared-message', 'Cloudflared Konfiguration darf nicht leer sein.', true, false);
        return;
      }

      setMessage('cloudflared-message', 'Speichere Cloudflared Config ...');
      var res = await api('/api/setup/cloudflared', {
        method: 'PUT',
        body: JSON.stringify({ content: content })
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        setMessage('cloudflared-message', body.message || 'Fehler beim Speichern', true, false);
        return;
      }

      setMessage('cloudflared-message', 'Cloudflared Konfiguration gespeichert.', false, true);
      await loadSetup();
    }

    async function applyRestart() {
      setMessage('setup-message', 'Neustart wird vorbereitet ...');
      var res = await api('/api/setup/apply', {
        method: 'POST',
        body: JSON.stringify({ restart: true })
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        setMessage('setup-message', body.message || 'Neustart konnte nicht angestossen werden.', true, false);
        return;
      }

      setMessage('setup-message', 'Neustart ausgeloest. Verbindung wird kurz unterbrochen.', false, true);
      setTimeout(function () {
        window.location.reload();
      }, 5000);
    }

    async function importAlexaDevices(silent) {
      if (alexaImportInFlight) {
        return;
      }
      alexaImportInFlight = true;

      if (!silent) {
        setMessage('import-message', 'Importiere Alexa Devices ...');
      }

      try {
        var res = await api('/api/targets/import/alexa-devices', {
          method: 'POST',
          body: JSON.stringify({ enabled: true })
        });
        var body = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          if (!silent) {
            setMessage('import-message', body.message || 'Import fehlgeschlagen', true, false);
          }
          return;
        }

        setMessage(
          'import-message',
          'Import abgeschlossen: ' + body.created + ' neu, ' + body.skipped + ' bereits vorhanden, ' + body.discovered + ' gefunden.',
          false,
          true
        );
        await refreshRuntimeTables(true);
      } finally {
        alexaImportInFlight = false;
      }
    }

    async function maybeAutoImportAlexaDevices(targetsBody) {
      if (alexaAutoImportAttempted) {
        return false;
      }

      var targets = targetsBody.targets || [];
      var hasDeviceTargets = targets.some(function (target) {
        return target.type === 'device';
      });
      if (hasDeviceTargets) {
        alexaAutoImportAttempted = true;
        return false;
      }

      var alexaInfo = targetsBody.alexa || {};
      if (alexaInfo.mode !== 'alexa_remote2' || !alexaInfo.initialized) {
        return false;
      }

      alexaAutoImportAttempted = true;
      await importAlexaDevices(true);
      return true;
    }

    async function refreshRuntimeTables(skipAutoImport) {
      var responses = await Promise.all([
        api('/api/targets'),
        api('/api/sessions'),
        api('/api/audit')
      ]);

      var targetsBody = await responses[0].json();
      var sessionsBody = await responses[1].json();
      var auditBody = await responses[2].json();

      if (!skipAutoImport) {
        var imported = await maybeAutoImportAlexaDevices(targetsBody);
        if (imported) {
          return;
        }
      }

      var targetsEl = document.getElementById('targets');
      targetsEl.innerHTML = '';
      for (var i = 0; i < targetsBody.targets.length; i += 1) {
        var t = targetsBody.targets[i];
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml(t.id) + '</td>' +
          '<td>' + escapeHtml(t.name) + '</td>' +
          '<td>' + escapeHtml(t.type) + '</td>' +
          '<td>' + escapeHtml(t.airplay_name) + '</td>' +
          '<td>' + escapeHtml(t.status) + '</td>' +
          '<td>' + (t.enabled ? 'yes' : 'no') + '</td>' +
          '<td><div class="target-actions"></div></td>';

        var actionCell = tr.querySelector('.target-actions');

        var toggle = document.createElement('button');
        toggle.className = 'secondary';
        toggle.textContent = t.enabled ? 'Disable' : 'Enable';
        toggle.onclick = async function (target) {
          var patchRes = await api('/api/targets/' + target.id, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !target.enabled })
          });
          if (!patchRes.ok) {
            var patchBody = await patchRes.json().catch(function () { return {}; });
            alert(patchBody.message || 'Update fehlgeschlagen');
          }
          await refreshRuntimeTables();
        }.bind(null, t);

        var reconcile = document.createElement('button');
        reconcile.className = 'secondary';
        reconcile.textContent = 'Reconcile';
        reconcile.onclick = async function (target) {
          var recRes = await api('/api/targets/' + target.id + '/reconcile', {
            method: 'POST',
            body: JSON.stringify({})
          });
          if (!recRes.ok) {
            var recBody = await recRes.json().catch(function () { return {}; });
            alert(recBody.message || 'Reconcile fehlgeschlagen');
          }
          await refreshRuntimeTables();
        }.bind(null, t);

        var del = document.createElement('button');
        del.className = 'danger';
        del.textContent = 'Delete';
        del.onclick = async function (target) {
          var delRes = await api('/api/targets/' + target.id, { method: 'DELETE' });
          if (!delRes.ok) {
            var delBody = await delRes.json().catch(function () { return {}; });
            alert(delBody.message || 'Loeschen fehlgeschlagen');
          }
          await refreshRuntimeTables();
        }.bind(null, t);

        actionCell.append(toggle, reconcile, del);
        targetsEl.appendChild(tr);
      }

      var sessionsEl = document.getElementById('sessions');
      sessionsEl.innerHTML = '';
      var sessions = sessionsBody.sessions || [];
      for (var s = 0; s < Math.min(sessions.length, 60); s += 1) {
        var session = sessions[s];
        var trSession = document.createElement('tr');
        trSession.innerHTML =
          '<td>' + escapeHtml(session.id) + '</td>' +
          '<td>' + escapeHtml(session.target_id) + '</td>' +
          '<td>' + escapeHtml(session.state) + '</td>' +
          '<td>' + escapeHtml(session.stream_url) + '</td>' +
          '<td>' + escapeHtml(session.started_at) + '</td>' +
          '<td>' + escapeHtml(session.ended_at || '') + '</td>';
        sessionsEl.appendChild(trSession);
      }

      var auditEl = document.getElementById('audit');
      auditEl.innerHTML = '';
      var auditRows = auditBody.audit || [];
      for (var a = 0; a < Math.min(auditRows.length, 120); a += 1) {
        var entry = auditRows[a];
        var trAudit = document.createElement('tr');
        trAudit.innerHTML =
          '<td>' + escapeHtml(entry.timestamp) + '</td>' +
          '<td>' + escapeHtml(entry.actor) + '</td>' +
          '<td>' + escapeHtml(entry.action) + '</td>' +
          '<td>' + escapeHtml(entry.target_id || '') + '</td>' +
          '<td>' + escapeHtml(entry.result) + '</td>' +
          '<td>' + escapeHtml(entry.details_json || '') + '</td>';
        auditEl.appendChild(trAudit);
      }
    }

    async function createTarget() {
      var payload = {
        name: document.getElementById('name').value,
        type: document.getElementById('type').value,
        alexa_device_id: document.getElementById('deviceId').value || undefined,
        alexa_group_id: document.getElementById('groupId').value || undefined,
        enabled: false
      };

      if (!payload.name || !payload.type) {
        setMessage('create-error', 'Name und Type sind Pflichtfelder.', true, false);
        return;
      }

      setMessage('create-error', 'Target wird erstellt ...');
      var res = await api('/api/targets', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        setMessage('create-error', body.message || 'Anlegen fehlgeschlagen', true, false);
        return;
      }

      document.getElementById('name').value = '';
      document.getElementById('deviceId').value = '';
      document.getElementById('groupId').value = '';
      setMessage('create-error', 'Target erstellt.', false, true);
      await refreshRuntimeTables();
    }

    document.getElementById('refresh-setup').onclick = function () {
      loadSetup().catch(function (error) {
        setMessage('setup-message', error.message || 'Setup konnte nicht geladen werden', true, false);
      });
    };

    document.getElementById('save-config').onclick = function () {
      saveSetupConfig().catch(function (error) {
        setMessage('config-message', error.message || 'Fehler beim Speichern', true, false);
      });
    };

    document.getElementById('save-admin-password').onclick = function () {
      saveAdminPassword().catch(function (error) {
        setMessage('password-message', error.message || 'Fehler beim Speichern', true, false);
      });
    };

    document.getElementById('save-cookie').onclick = function () {
      saveAlexaCookie().catch(function (error) {
        setMessage('cookie-message', error.message || 'Fehler beim Speichern', true, false);
      });
    };

    document.getElementById('start-alexa-wizard').onclick = function () {
      startAlexaWizard().catch(function (error) {
        setMessage('alexa-wizard-message', error.message || 'Wizard Start fehlgeschlagen', true, false);
      });
    };

    document.getElementById('refresh-alexa-wizard').onclick = function () {
      refreshAlexaWizardStatus().catch(function (error) {
        setMessage('alexa-wizard-message', error.message || 'Wizard Status fehlgeschlagen', true, false);
      });
    };

    document.getElementById('stop-alexa-wizard').onclick = function () {
      stopAlexaWizard().catch(function (error) {
        setMessage('alexa-wizard-message', error.message || 'Wizard Stop fehlgeschlagen', true, false);
      });
    };

    document.getElementById('save-cloudflared').onclick = function () {
      saveCloudflaredConfig().catch(function (error) {
        setMessage('cloudflared-message', error.message || 'Fehler beim Speichern', true, false);
      });
    };

    document.getElementById('apply-restart').onclick = function () {
      applyRestart().catch(function (error) {
        setMessage('setup-message', error.message || 'Neustart fehlgeschlagen', true, false);
      });
    };

    document.getElementById('create').onclick = function () {
      createTarget().catch(function (error) {
        setMessage('create-error', error.message || 'Fehler beim Erstellen', true, false);
      });
    };

    document.getElementById('import-alexa-devices').onclick = function () {
      importAlexaDevices(false).catch(function (error) {
        setMessage('import-message', error.message || 'Import fehlgeschlagen', true, false);
      });
    };

    document.getElementById('reload-all').onclick = function () {
      Promise.all([loadSetup(), refreshRuntimeTables()]).catch(function (error) {
        setMessage('setup-message', error.message || 'Aktualisierung fehlgeschlagen', true, false);
      });
    };

    document.getElementById('logout').onclick = async function () {
      await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
      window.location.href = '/login';
    };

    Promise.all([loadSetup(), refreshRuntimeTables()]).catch(function (error) {
      setMessage('setup-message', error.message || 'Initiales Laden fehlgeschlagen', true, false);
    });

    setInterval(function () {
      refreshRuntimeTables().catch(function () {});
    }, 7000);
  </script>
</body>
</html>`;
}
