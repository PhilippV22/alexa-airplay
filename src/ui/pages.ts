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
      <div id="setup-checklist" style="margin-bottom: 8px;"></div>
      <div class="status-grid" id="setup-status"></div>
      <div class="row" style="margin-bottom: 8px;">
        <button class="secondary" id="refresh-setup">Setup Status aktualisieren</button>
        <button class="success" id="apply-restart">Aenderungen anwenden (AirBridge Neustart)</button>
      </div>
      <p class="msg" id="setup-message"></p>

      <h3>Basis Konfiguration</h3>
      <div class="row">
        <label>Bind Host
          <input id="cfg-bind-host" placeholder="0.0.0.0" />
        </label>
        <label>Port
          <input id="cfg-port" placeholder="3000" />
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
    </section>

    <section style="grid-column: 1 / -1;">
      <h2>Bluetooth Setup</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin:0 0 8px;">
        Echo in Pairing-Modus setzen (Alexa-App → Geraet → Bluetooth → Neues Geraet koppeln), dann "Scannen".
      </p>
      <div class="row" style="margin-bottom:8px;">
        <button class="success" id="bt-scan">Bluetooth scannen (~8s)</button>
        <button class="secondary" id="bt-list">Bekannte Geraete</button>
      </div>
      <div id="bt-devices" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;"></div>
      <p class="msg" id="bt-message"></p>
    </section>

    <section style="grid-column: 1 / -1;">
      <h2>Targets</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>MAC</th><th>AirPlay</th><th>Status</th><th>Enabled</th><th>Aktion</th>
          </tr>
        </thead>
        <tbody id="targets"></tbody>
      </table>
    </section>

    <section style="grid-column: 1 / -1;">
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
      AIRBRIDGE_BIND_HOST: 'cfg-bind-host',
      AIRBRIDGE_PORT: 'cfg-port',
      AIRBRIDGE_SESSION_SECRET: 'cfg-session-secret',
      AIRBRIDGE_ADMIN_USER: 'cfg-admin-user',
      AIRBRIDGE_FFMPEG_BITRATE: 'cfg-ffmpeg-bitrate',
      AIRBRIDGE_SHAIRPORT_BIN: 'cfg-shairport-bin',
      AIRBRIDGE_FFMPEG_BIN: 'cfg-ffmpeg-bin'
    };

    function setMessage(id, text, isError, isSuccess) {
      var el = document.getElementById(id);
      if (!el) { return; }
      el.textContent = text || '';
      el.classList.remove('err');
      el.classList.remove('ok');
      if (isError) { el.classList.add('err'); }
      if (isSuccess) { el.classList.add('ok'); }
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

      try {
        var healthRes = await fetch('/health/setup');
        if (healthRes.ok) {
          var healthBody = await healthRes.json();
          renderHealthSetup(healthBody);
        }
      } catch (_e) { /* ignore */ }

      setMessage('setup-message', 'Setup geladen.', false, true);
    }

    function renderSetupStatus(status) {
      var el = document.getElementById('setup-status');
      el.innerHTML = '';

      var items = [
        ['ENV File', status.envFileExists, status.envFileExists ? 'vorhanden' : 'fehlt'],
        ['ENV write', status.envWritable, status.envWritable ? 'ok' : 'kein Zugriff'],
        ['Admin Hash', status.hasAdminPasswordHash, status.hasAdminPasswordHash ? 'gesetzt' : 'fehlt'],
        ['Session Secret', status.hasSessionSecret, status.hasSessionSecret ? 'gesetzt' : 'fehlt'],
        ['AirBridge Service', status.services && status.services.airbridge && status.services.airbridge.active === 'active',
          status.services && status.services.airbridge ? (status.services.airbridge.active + ' / ' + status.services.airbridge.enabled) : 'unbekannt']
      ];

      for (var i = 0; i < items.length; i += 1) {
        var card = document.createElement('div');
        var isOk = items[i][1];
        card.className = 'status-item';
        card.style.borderColor = isOk ? '#166534' : '#7f1d1d';
        card.style.background = isOk ? 'rgba(5,46,22,0.35)' : 'rgba(69,10,10,0.35)';
        var icon = isOk ? '✅' : '❌';
        card.innerHTML = '<b>' + escapeHtml(String(items[i][0])) + '</b>' + icon + ' ' + escapeHtml(String(items[i][2]));
        el.appendChild(card);
      }
    }

    function renderHealthSetup(health) {
      var checklist = document.getElementById('setup-checklist');
      if (!checklist) return;

      var checks = [
        { label: 'shairport-sync', ok: health.shairportBin && health.shairportBin.ok, hint: health.shairportBin && health.shairportBin.ok ? health.shairportBin.path : 'nicht gefunden: ' + (health.shairportBin && health.shairportBin.path) },
        { label: 'ffmpeg', ok: health.ffmpegBin && health.ffmpegBin.ok, hint: health.ffmpegBin && health.ffmpegBin.ok ? health.ffmpegBin.path : 'nicht gefunden: ' + (health.ffmpegBin && health.ffmpegBin.path) },
        { label: 'Aktive Targets', ok: health.activeTargets && health.activeTargets.ok, hint: health.activeTargets ? (health.activeTargets.count + ' Target(s) aktiv') : '0 Targets – Bluetooth Setup oben nutzen' }
      ];

      var allOk = checks.every(function (c) { return c.ok; });
      var html = '';

      if (!allOk) {
        html += '<div style="background:rgba(120,50,0,0.35);border:1px solid #92400e;border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:0.85rem;color:#fde68a;">';
        html += '<b>Setup unvollstaendig</b> – folgende Punkte beachten:';
        html += '</div>';
      }

      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">';
      for (var i = 0; i < checks.length; i += 1) {
        var c = checks[i];
        var bg = c.ok ? 'rgba(5,46,22,0.35)' : 'rgba(69,10,10,0.35)';
        var border = c.ok ? '#166534' : '#7f1d1d';
        var icon = c.ok ? '✅' : '❌';
        html += '<div style="padding:7px 10px;border-radius:8px;border:1px solid ' + border + ';background:' + bg + ';font-size:0.8rem;">';
        html += '<b style="display:block;margin-bottom:2px;">' + icon + ' ' + escapeHtml(c.label) + '</b>';
        html += '<span style="color:#9fb4cc;">' + escapeHtml(c.hint || '') + '</span>';
        html += '</div>';
      }
      html += '</div>';

      checklist.innerHTML = html;
    }

    function fillSetupConfig(values) {
      var keys = Object.keys(setupKeyMap);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        var id = setupKeyMap[key];
        var input = document.getElementById(id);
        if (input) { input.value = values[key] || ''; }
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
      setTimeout(function () { window.location.reload(); }, 5000);
    }

    async function refreshRuntimeTables() {
      var responses = await Promise.all([
        api('/api/targets'),
        api('/api/audit')
      ]);

      var targetsBody = await responses[0].json();
      var auditBody = await responses[1].json();

      var targetsEl = document.getElementById('targets');
      targetsEl.innerHTML = '';
      for (var i = 0; i < targetsBody.targets.length; i += 1) {
        var t = targetsBody.targets[i];
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml(t.id) + '</td>' +
          '<td>' + escapeHtml(t.name) + '</td>' +
          '<td>' + escapeHtml(t.bluetooth_mac || '') + '</td>' +
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

    function renderBtDevices(devices) {
      var el = document.getElementById('bt-devices');
      el.innerHTML = '';
      if (!devices.length) {
        el.innerHTML = '<span style="color:var(--muted);font-size:0.83rem;">Keine Geraete gefunden.</span>';
        return;
      }
      for (var i = 0; i < devices.length; i += 1) {
        var d = devices[i];
        var card = document.createElement('div');
        card.style.cssText = 'padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card-2);font-size:0.82rem;display:flex;align-items:center;gap:10px;';
        var label = document.createElement('span');
        label.textContent = d.name + '  (' + d.mac + ')';
        var pairBtn = document.createElement('button');
        pairBtn.textContent = 'Koppeln & Target erstellen';
        pairBtn.className = 'success';
        pairBtn.style.padding = '4px 8px';
        pairBtn.style.fontSize = '0.78rem';
        (function (mac, name) {
          pairBtn.onclick = function () {
            setMessage('bt-message', 'Koppele ' + mac + ' ...');
            api('/api/bt/pair', { method: 'POST', body: JSON.stringify({ mac: mac }) })
              .then(function (r) { return r.json(); })
              .then(function (body) {
                if (body.error) { setMessage('bt-message', body.message || 'Fehler', true, false); return; }
                return api('/api/targets', {
                  method: 'POST',
                  body: JSON.stringify({ name: name, type: 'bluetooth', bluetooth_mac: mac, airplay_name: 'AirBridge ' + name, enabled: true })
                });
              })
              .then(function (r) {
                if (!r) return;
                if (!r.ok) { return r.json().then(function (b) { setMessage('bt-message', b.message || 'Target-Fehler', true, false); }); }
                setMessage('bt-message', 'Gekoppelt und Target erstellt: ' + name, false, true);
                refreshRuntimeTables();
              })
              .catch(function (e) { setMessage('bt-message', e.message || 'Fehler', true, false); });
          };
        })(d.mac, d.name);
        card.appendChild(label);
        card.appendChild(pairBtn);
        el.appendChild(card);
      }
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

    document.getElementById('apply-restart').onclick = function () {
      applyRestart().catch(function (error) {
        setMessage('setup-message', error.message || 'Neustart fehlgeschlagen', true, false);
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

    document.getElementById('bt-scan').onclick = function () {
      setMessage('bt-message', 'Scanne... (ca. 8 Sekunden)');
      document.getElementById('bt-devices').innerHTML = '';
      api('/api/bt/scan', { method: 'POST', body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (b) {
          renderBtDevices(b.devices || []);
          setMessage('bt-message', (b.devices || []).length + ' Geraet(e) gefunden.', false, true);
        })
        .catch(function (e) { setMessage('bt-message', e.message || 'Scan fehlgeschlagen', true, false); });
    };

    document.getElementById('bt-list').onclick = function () {
      api('/api/bt/devices')
        .then(function (r) { return r.json(); })
        .then(function (b) { renderBtDevices(b.devices || []); setMessage('bt-message', '', false, false); })
        .catch(function (e) { setMessage('bt-message', e.message || 'Fehler', true, false); });
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
