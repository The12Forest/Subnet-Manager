'use strict';

const SettingsPanel = {
  _settings: {},  // key -> enriched setting object
  _currentTab: 'general',

  open() {
    document.getElementById('settings-panel').classList.add('open');
    document.getElementById('settings-backdrop').classList.add('active');
    SettingsPanel.load();
  },

  close() {
    document.getElementById('settings-panel').classList.remove('open');
    document.getElementById('settings-backdrop').classList.remove('active');
  },

  tab(name) {
    SettingsPanel._currentTab = name;
    document.querySelectorAll('.panel-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name)
    );
    document.querySelectorAll('.tab-content').forEach(c =>
      c.classList.toggle('active', c.id === `tab-${name}`)
    );
    if (name === 'users')    UsersPanel.load();
    if (name === 'auditlog') SettingsPanel.loadAudit();
    if (name === 'about')    SettingsPanel.loadAbout();
    if (name === 'backups')  SettingsPanel.loadBackups();
  },

  async load() {
    try {
      const rows = await fetch('/api/v1/settings').then(r => r.json());
      SettingsPanel._settings = {};
      for (const r of rows) SettingsPanel._settings[r.key] = r;
      SettingsPanel._applyToForm();
    } catch (err) {
      console.error('[settings] Load error:', err);
    }
  },

  _get(key) {
    const r = SettingsPanel._settings[key];
    return r ? r.value : '';
  },

  _applyToForm() {
    const keys = [
      'app_name', 'bind_host', 'theme_default',
      'max_users', 'session_timeout',
      'port', 'mcp_port',
      'check_interval', 'check_timeout', 'check_enabled',
      'network_mode',
      'backup_enabled', 'backup_interval_hours', 'backup_max_count',
    ];
    for (const key of keys) {
      SettingsPanel._applyField(key);
    }
  },

  _applyField(key) {
    const inputId = `set-${key.replace(/_/g, '-')}`;
    const labelId = `label-${key.replace(/_/g, '-')}`;
    const el      = document.getElementById(inputId);
    const labelEl = document.getElementById(labelId);
    const row     = SettingsPanel._settings[key];
    if (!el || !row) return;

    // Set value
    if (el.type === 'checkbox') {
      el.checked = row.value === 'true';
    } else {
      el.value = row.value;
    }

    // Remove old badges/reset buttons
    const parent = el.closest('.setting-row') || el.parentElement;
    parent.querySelectorAll('.env-badge, .reset-btn').forEach(e => e.remove());
    if (labelEl) labelEl.querySelectorAll('.env-badge').forEach(e => e.remove());

    // Add env badge and reset button if an env var is set
    if (row.has_env) {
      const badge = document.createElement('span');
      badge.className = 'env-badge';
      badge.title = `Environment variable: ${row.env_value}`;
      badge.textContent = row.from_env ? 'env' : `env: ${row.env_value}`;
      if (labelEl) labelEl.appendChild(badge);

      // Show reset button only when user has overridden env
      if (!row.from_env) {
        const resetBtn = document.createElement('button');
        resetBtn.className = 'reset-btn';
        resetBtn.title = `Reset to env value: ${row.env_value}`;
        resetBtn.textContent = '↩ env';
        resetBtn.onclick = () => SettingsPanel.resetToEnv(key);
        // Insert after the input inside .setting-row
        if (el.closest('.setting-row')) {
          el.closest('.setting-row').appendChild(resetBtn);
        }
      }
    }
  },

  async _save(updates, successMsg) {
    const res = await fetch('/api/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      App.toast(successMsg || 'Saved', 'success');
      await SettingsPanel.load();
    } else {
      const d = await res.json();
      App.toast(d.error || 'Save failed', 'error');
    }
  },

  async resetToEnv(key) {
    const res = await fetch(`/api/v1/settings/${key}/override`, { method: 'DELETE' });
    if (res.ok) {
      App.toast('Reset to environment value', 'info');
      await SettingsPanel.load();
    } else {
      const d = await res.json();
      App.toast(d.error || 'Reset failed', 'error');
    }
  },

  async saveGeneral() {
    const name      = document.getElementById('set-app-name').value.trim();
    const bindHost  = document.getElementById('set-bind-host').value.trim();
    const theme     = document.getElementById('set-theme-default').value;
    if (!name) { App.toast('App name cannot be empty', 'error'); return; }

    const updates = { app_name: name, theme_default: theme };
    if (bindHost) updates.bind_host = bindHost;

    await SettingsPanel._save(updates, bindHost ? 'Saved — bind host change requires restart' : 'General settings saved');
    document.title = name;
  },

  async saveSecurity() {
    const maxUsers = document.getElementById('set-max-users').value;
    const timeout  = document.getElementById('set-session-timeout').value;
    await SettingsPanel._save({ max_users: maxUsers, session_timeout: timeout }, 'Security settings saved');
  },

  async saveNetwork() {
    const interval = document.getElementById('set-check-interval').value;
    const timeout  = document.getElementById('set-check-timeout').value;
    const enabled  = document.getElementById('set-check-enabled').checked ? 'true' : 'false';
    await SettingsPanel._save({ check_interval: interval, check_timeout: timeout, check_enabled: enabled }, 'Network settings saved');
  },

  async saveNetworkMode() {
    const mode = document.getElementById('set-network-mode').value;
    await SettingsPanel._save({ network_mode: mode }, 'Network mode saved');
  },

  async savePorts() {
    const port    = document.getElementById('set-port').value.trim();
    const mcpPort = document.getElementById('set-mcp-port').value.trim();
    if (!port || !mcpPort) { App.toast('Both ports are required', 'error'); return; }

    const ok = await App.confirm(
      `<b>Changing ports requires a server restart.</b><br><br>` +
      `If you are running in Docker you must <b>also update the port mapping</b> in <code>docker-compose.yml</code> before restarting.<br><br>` +
      `<span style="color:var(--danger)">⚠ If the new port is inaccessible (wrong mapping, firewall, etc.) you will lose access and cannot revert through the UI.</span>`,
      { confirmLabel: 'Change Ports', danger: true }
    );
    if (!ok) return;

    await SettingsPanel._save({ port, mcp_port: mcpPort }, 'Port settings saved — restart required');
  },

  async loadAudit() {
    const container = document.getElementById('audit-panel-content');
    container.innerHTML = '<p style="color:var(--muted);font-size:13px">Loading…</p>';
    try {
      const data = await fetch('/api/v1/audit?limit=50').then(r => r.json());
      if (!data.rows || data.rows.length === 0) {
        container.innerHTML = '<p style="color:var(--muted);font-size:13px">No audit entries yet.</p>';
        return;
      }
      container.innerHTML = `
        <table class="audit-table">
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th></tr></thead>
          <tbody>
            ${data.rows.map(r => `
              <tr>
                <td style="white-space:nowrap">${new Date(r.created_at).toLocaleString()}</td>
                <td>${App.esc(r.username || '—')}</td>
                <td><span class="action-badge ${r.action}">${r.action}</span></td>
                <td>${r.target_type || ''}${r.target_id ? ' #' + r.target_id : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    } catch {
      container.innerHTML = '<p style="color:var(--danger);font-size:13px">Failed to load audit log</p>';
    }
  },

  async loadAbout() {
    try {
      if (!SettingsPanel._settings || !Object.keys(SettingsPanel._settings).length) {
        await SettingsPanel.load();
      }
      const idEl     = document.getElementById('about-oauth-id');
      const secretEl = document.getElementById('about-oauth-secret');
      const urlEl    = document.getElementById('about-mcp-url');

      if (idEl)     idEl.value     = SettingsPanel._get('mcp_oauth_client_id')     || 'claude-client';
      if (secretEl) secretEl.value = SettingsPanel._get('mcp_oauth_client_secret') || '';

      // Fetch version + actual running ports + MCP token (token only returned for admins)
      const about = await fetch('/api/v1/settings/about').then(r => r.json()).catch(() => ({}));

      // Build MCP URL using the actual running MCP port from the server
      if (urlEl) {
        const mcpPort = about.mcp_port || 3001;
        urlEl.value = `${window.location.protocol}//${window.location.hostname}:${mcpPort}/mcp`;
      }

      const versionEl = document.getElementById('about-version');
      if (versionEl) versionEl.textContent = `v${about.version || 'dev'}`;

      const bearerSection = document.getElementById('about-bearer-section');
      const tokenEl       = document.getElementById('about-mcp-token');
      if (about.mcp_token && bearerSection && tokenEl) {
        bearerSection.style.display = '';
        tokenEl.textContent = about.mcp_token;
      }

      // Show API tokens section for admins
      const tokensSection = document.getElementById('about-tokens-section');
      if (tokensSection && about.api_tokens) {
        tokensSection.style.display = '';
        SettingsPanel.renderTokens(about.api_tokens);
      }
    } catch { /* ignore */ }
  },

  toggleSecret() {
    const el = document.getElementById('about-oauth-secret');
    if (el) el.type = el.type === 'password' ? 'text' : 'password';
  },

  generateSecret() {
    const chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => chars[b % chars.length]).join('');
    const el = document.getElementById('about-oauth-secret');
    if (el) { el.value = secret; el.type = 'text'; }
    App.toast('New secret generated — click Save Credentials to apply', 'info');
  },

  async saveMcpCredentials() {
    const id     = (document.getElementById('about-oauth-id')?.value     || '').trim();
    const secret = (document.getElementById('about-oauth-secret')?.value || '').trim();
    if (!id) { App.toast('Client ID cannot be empty', 'error'); return; }

    await SettingsPanel._save(
      { mcp_oauth_client_id: id, mcp_oauth_client_secret: secret },
      'MCP credentials saved — takes effect immediately'
    );
  },

  async loadBackups() {
    // Apply form fields from already-loaded settings
    SettingsPanel._applyField('backup_enabled');
    SettingsPanel._applyField('backup_interval_hours');
    SettingsPanel._applyField('backup_max_count');

    // Show last run time
    const lastRun   = SettingsPanel._get('backup_last_run');
    const lastRunEl = document.getElementById('backup-last-run');
    if (lastRunEl) {
      lastRunEl.textContent = lastRun
        ? `Last backup: ${new Date(lastRun).toLocaleString()}`
        : 'No backups have run yet';
    }

    // Load backup file list
    const container = document.getElementById('backup-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--muted);font-size:13px">Loading…</p>';
    try {
      const backups = await fetch('/api/v1/backup').then(r => r.json());
      if (!backups.length) {
        container.innerHTML = '<p style="color:var(--muted);font-size:13px">No backup files yet</p>';
        return;
      }
      container.innerHTML = backups.map(b => `
        <div class="backup-row">
          <span class="backup-name mono">${App.esc(b.name)}</span>
          <span class="backup-size">${SettingsPanel._formatBytes(b.size)}</span>
          <span class="backup-date">${new Date(b.created_at).toLocaleString()}</span>
          <div class="backup-actions">
            <a href="/api/v1/backup/${encodeURIComponent(b.name)}" download
               class="btn btn-secondary btn-sm" title="Download">↓</a>
            <button class="btn btn-danger btn-sm" title="Delete"
                    onclick="SettingsPanel.deleteBackup('${App.esc(b.name)}')">×</button>
          </div>
        </div>`).join('');
    } catch {
      container.innerHTML = '<p style="color:var(--danger);font-size:13px">Failed to load backups</p>';
    }
  },

  _formatBytes(bytes) {
    if (bytes < 1024)        return `${bytes} B`;
    if (bytes < 1048576)     return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  },

  async saveBackupSettings() {
    const enabled  = document.getElementById('set-backup-enabled')?.checked ? 'true' : 'false';
    const interval = document.getElementById('set-backup-interval-hours')?.value || '24';
    const maxCount = document.getElementById('set-backup-max-count')?.value || '7';
    await SettingsPanel._save(
      { backup_enabled: enabled, backup_interval_hours: interval, backup_max_count: maxCount },
      'Backup settings saved'
    );
  },

  async runBackup() {
    const btn = document.getElementById('backup-now-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Backing up…'; }
    try {
      const res = await fetch('/api/v1/backup', { method: 'POST' });
      const d   = await res.json();
      if (!res.ok) throw new Error(d.error || 'Backup failed');
      App.toast(`Backup created: ${d.latest}`, 'success');
      await SettingsPanel.load();
      SettingsPanel.loadBackups();
    } catch (err) {
      App.toast(err.message || 'Backup failed', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Backup Now'; }
    }
  },

  async deleteBackup(name) {
    const ok = await App.confirm(
      `Delete backup <b>${App.esc(name)}</b>? This cannot be undone.`,
      { confirmLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    const res = await fetch(`/api/v1/backup/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.ok) {
      App.toast('Backup deleted', 'success');
      SettingsPanel.loadBackups();
    } else {
      App.toast('Failed to delete backup', 'error');
    }
  },

  // ── API Token Management ────────────────────────────────────────────────────

  renderTokens(tokens) {
    const container = document.getElementById('about-tokens-list');
    if (!container) return;
    if (!tokens || tokens.length === 0) {
      container.innerHTML = '<p style="color:var(--muted);font-size:13px">No API tokens created yet</p>';
      return;
    }
    container.innerHTML = tokens.map(t => {
      const dotColor = t.revoked ? 'var(--offline)' : 'var(--online)';
      const lastUsed = t.last_used_at
        ? new Date(t.last_used_at).toLocaleString()
        : 'Never';
      const actions  = t.revoked
        ? `<button class="btn btn-danger btn-sm" onclick="SettingsPanel.deleteToken(${t.id}, '${App.esc(t.name)}')">Delete</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="SettingsPanel.rollToken(${t.id})">Roll</button>
           <button class="btn btn-danger btn-sm" onclick="SettingsPanel.revokeToken(${t.id}, '${App.esc(t.name)}')">Revoke</button>`;
      return `
        <div class="token-row" style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);gap:8px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0"></span>
            <span style="font-weight:600;font-size:13px;color:var(--text)">${App.esc(t.name)}</span>
            <code style="font-size:10px;font-family:monospace;color:var(--muted)">${App.esc(t.prefix)}...</code>
            <span class="action-badge ${t.revoked ? 'delete' : ''}" style="font-size:9px">${t.role}</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
            <span style="font-size:11px;color:var(--muted)">${lastUsed}</span>
            <div style="display:flex;gap:4px">${actions}</div>
          </div>
        </div>`;
    }).join('');
  },

  showCreateTokenDialog() {
    App.openModal(`
      <div class="modal-header">
        <h3>Create API Token</h3>
        <button class="modal-close" onclick="App.closeModal()">×</button>
      </div>
      <div class="form-group">
        <label>Token Name *</label>
        <input type="text" id="m-token-name" placeholder="e.g. CI/CD Pipeline" maxlength="64">
        <span class="hint">Choose a descriptive name to identify this token</span>
      </div>
      <div class="error-msg hidden" id="m-token-err"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="SettingsPanel.createToken()">Create Token</button>
      </div>
    `);
  },

  async createToken() {
    const name  = document.getElementById('m-token-name').value.trim();
    const errEl = document.getElementById('m-token-err');
    if (!name) {
      errEl.textContent = 'Token name is required';
      errEl.classList.remove('hidden');
      return;
    }
    try {
      const res  = await fetch('/api/v1/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || 'Failed to create token';
        errEl.classList.remove('hidden');
        return;
      }
      // Show the raw token in the modal — only time it is visible
      App.openModal(`
        <div class="modal-header">
          <h3>Token Created — Copy Now</h3>
          <button class="modal-close" onclick="App.closeModal();SettingsPanel.loadAbout()">×</button>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
          This token <b>will not be shown again</b>. Copy it now and store it securely.
        </p>
        <div class="token-box" style="user-select:all;cursor:pointer;word-break:break-all"
             onclick="navigator.clipboard.writeText(this.textContent.trim()).then(()=>App.toast('Copied','success'))"
             title="Click to copy">${data.token}</div>
        <span class="hint">Token <b>${App.esc(data.name)}</b> (${data.role}) — click to copy</span>
        <div class="modal-footer">
          <button class="btn btn-primary" onclick="App.closeModal();SettingsPanel.loadAbout()">Done</button>
        </div>
      `);
    } catch {
      App.toast('Failed to create token', 'error');
    }
  },

  async rollToken(id) {
    const ok = await App.confirm(
      'Roll this token? The old token will be <b>immediately revoked</b> and a new one generated.',
      { confirmLabel: 'Roll Token' }
    );
    if (!ok) return;
    try {
      const res  = await fetch(`/api/v1/tokens/${id}/roll`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        App.toast(data.error || 'Roll failed', 'error');
        return;
      }
      App.openModal(`
        <div class="modal-header">
          <h3>Token Rolled — Copy New Token</h3>
          <button class="modal-close" onclick="App.closeModal();SettingsPanel.loadAbout()">×</button>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
          The previous token has been revoked. This is the new token for <b>${App.esc(data.name)}</b>.
        </p>
        <div class="token-box" style="user-select:all;cursor:pointer;word-break:break-all"
             onclick="navigator.clipboard.writeText(this.textContent.trim()).then(()=>App.toast('Copied','success'))"
             title="Click to copy">${data.token}</div>
        <span class="hint">Click the token to copy — it will not be shown again</span>
        <div class="modal-footer">
          <button class="btn btn-primary" onclick="App.closeModal();SettingsPanel.loadAbout()">Done</button>
        </div>
      `);
    } catch {
      App.toast('Failed to roll token', 'error');
    }
  },

  async revokeToken(id, name) {
    const ok = await App.confirm(
      `Revoke token <b>${App.esc(name)}</b>? It will stop working immediately.`,
      { confirmLabel: 'Revoke', danger: true }
    );
    if (!ok) return;
    const res = await fetch(`/api/v1/tokens/${id}/revoke`, { method: 'POST' });
    if (res.ok) {
      App.toast('Token revoked', 'success');
      SettingsPanel.loadAbout();
    } else {
      const d = await res.json();
      App.toast(d.error || 'Revoke failed', 'error');
    }
  },

  async deleteToken(id, name) {
    const ok = await App.confirm(
      `Permanently delete token <b>${App.esc(name)}</b>? This cannot be undone.`,
      { confirmLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    const res = await fetch(`/api/v1/tokens/${id}`, { method: 'DELETE' });
    if (res.ok) {
      App.toast('Token deleted', 'success');
      SettingsPanel.loadAbout();
    } else {
      const d = await res.json();
      App.toast(d.error || 'Delete failed', 'error');
    }
  },

  async importJSON(input) {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res  = await fetch('/api/v1/import/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) {
        App.toast(result.error || 'Import failed', 'error');
      } else {
        App.toast(`Imported ${result.imported.subnets} subnets, ${result.imported.hosts} hosts`, 'success');
        await App.loadData();
        App.render();
      }
    } catch {
      App.toast('Invalid JSON file', 'error');
    } finally {
      input.value = '';
    }
  },
};
