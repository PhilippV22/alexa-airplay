export function loginPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AirBridge Login</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; background: #f0f4f8; color: #0f172a; }
    main { max-width: 440px; margin: 10vh auto; background: white; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(15,23,42,.15); }
    h1 { margin: 0 0 16px; font-size: 1.4rem; }
    label { display: block; margin-bottom: 12px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; }
    button { width: 100%; border: 0; background: #1d4ed8; color: white; border-radius: 8px; padding: 10px 12px; font-weight: 600; }
    .error { color: #b91c1c; min-height: 1.2rem; margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>AirBridge Admin</h1>
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

    form.addEventListener('submit', async (ev) => {
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
        const body = await res.json().catch(() => ({}));
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
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AirBridge</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; background: #0b1220; color: #e2e8f0; }
    header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: #111827; border-bottom: 1px solid #1f2937; }
    main { padding: 16px 20px 40px; display: grid; gap: 16px; }
    section { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 14px; }
    h1 { margin: 0; font-size: 1.2rem; }
    h2 { margin-top: 0; font-size: 1rem; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { text-align: left; border-bottom: 1px solid #1f2937; padding: 8px 4px; }
    button { background: #1d4ed8; border: 0; color: #fff; border-radius: 6px; padding: 8px 10px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .row input, .row select { background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 8px; }
    .err { color: #fca5a5; min-height: 1.2rem; }
  </style>
</head>
<body>
  <header>
    <h1>AirBridge Dashboard</h1>
    <div class="row">
      <span>${adminUser}</span>
      <button id="logout">Logout</button>
    </div>
  </header>
  <main>
    <section>
      <h2>Target anlegen</h2>
      <div class="row">
        <input id="name" placeholder="Name" />
        <select id="type">
          <option value="device">device</option>
          <option value="group">group</option>
        </select>
        <input id="deviceId" placeholder="alexa_device_id" />
        <input id="groupId" placeholder="alexa_group_id" />
        <button id="create">Erstellen</button>
      </div>
      <p class="err" id="create-error"></p>
    </section>

    <section>
      <h2>Targets</h2>
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
        <thead><tr><th>ID</th><th>Target</th><th>State</th><th>URL</th><th>Start</th><th>Ende</th></tr></thead>
        <tbody id="sessions"></tbody>
      </table>
    </section>

    <section>
      <h2>Audit</h2>
      <table>
        <thead><tr><th>Zeit</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th><th>Details</th></tr></thead>
        <tbody id="audit"></tbody>
      </table>
    </section>
  </main>

  <script>
    async function api(path, opts = {}) {
      const res = await fetch(path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('unauthorized');
      }
      return res;
    }

    async function refreshAll() {
      const [targetsRes, sessionsRes, auditRes] = await Promise.all([
        api('/api/targets'),
        api('/api/sessions'),
        api('/api/audit')
      ]);

      const targetsBody = await targetsRes.json();
      const sessionsBody = await sessionsRes.json();
      const auditBody = await auditRes.json();

      const targetsEl = document.getElementById('targets');
      targetsEl.innerHTML = '';
      for (const t of targetsBody.targets) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + t.id + '</td>' +
          '<td>' + t.name + '</td>' +
          '<td>' + t.type + '</td>' +
          '<td>' + t.airplay_name + '</td>' +
          '<td>' + t.status + '</td>' +
          '<td>' + (t.enabled ? 'yes' : 'no') + '</td>' +
          '<td class=\"row\"></td>';

        const actionCell = tr.querySelector('td:last-child');
        const toggle = document.createElement('button');
        toggle.textContent = t.enabled ? 'Disable' : 'Enable';
        toggle.onclick = async () => {
          const res = await api('/api/targets/' + t.id, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !t.enabled })
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            alert(body.message || 'Update failed');
          }
          refreshAll();
        };

        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.onclick = async () => {
          await api('/api/targets/' + t.id, { method: 'DELETE' });
          refreshAll();
        };

        actionCell.append(toggle, del);
        targetsEl.appendChild(tr);
      }

      const sessionsEl = document.getElementById('sessions');
      sessionsEl.innerHTML = '';
      for (const s of sessionsBody.sessions.slice(0, 40)) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + s.id + '</td>' +
          '<td>' + s.target_id + '</td>' +
          '<td>' + s.state + '</td>' +
          '<td>' + s.stream_url + '</td>' +
          '<td>' + s.started_at + '</td>' +
          '<td>' + (s.ended_at || '') + '</td>';
        sessionsEl.appendChild(tr);
      }

      const auditEl = document.getElementById('audit');
      auditEl.innerHTML = '';
      for (const a of auditBody.audit.slice(0, 80)) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + a.timestamp + '</td>' +
          '<td>' + a.actor + '</td>' +
          '<td>' + a.action + '</td>' +
          '<td>' + (a.target_id || '') + '</td>' +
          '<td>' + a.result + '</td>' +
          '<td>' + a.details_json + '</td>';
        auditEl.appendChild(tr);
      }
    }

    document.getElementById('create').onclick = async () => {
      const payload = {
        name: document.getElementById('name').value,
        type: document.getElementById('type').value,
        alexa_device_id: document.getElementById('deviceId').value || undefined,
        alexa_group_id: document.getElementById('groupId').value || undefined,
        enabled: false
      };

      const error = document.getElementById('create-error');
      error.textContent = '';
      const res = await api('/api/targets', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error.textContent = body.message || 'Anlegen fehlgeschlagen';
        return;
      }

      document.getElementById('name').value = '';
      document.getElementById('deviceId').value = '';
      document.getElementById('groupId').value = '';
      refreshAll();
    };

    document.getElementById('logout').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    };

    refreshAll();
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
}
