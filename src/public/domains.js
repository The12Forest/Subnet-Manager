'use strict';

const DomainsPage = {
  _domains:  [],
  _expanded: null,

  async load() {
    const container = document.getElementById('domains-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">Loading…</p>';
    try {
      DomainsPage._domains = await fetch('/api/v1/domains').then(r => r.json());
      DomainsPage._render();
    } catch {
      container.innerHTML = '<p style="color:var(--danger);font-size:13px">Failed to load domains</p>';
    }
  },

  _render() {
    const container = document.getElementById('domains-list');
    if (!container) return;
    if (!DomainsPage._domains.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⊕</div>
          <h3>No domains yet</h3>
          <p>Add a second-level domain (e.g. <span class="mono">example.com</span>) to start managing subdomains</p>
        </div>`;
      return;
    }
    container.innerHTML = DomainsPage._domains.map(d => DomainsPage._cardHtml(d)).join('');
    if (DomainsPage._expanded !== null) {
      DomainsPage._loadRecords(DomainsPage._expanded);
    }
  },

  _cardHtml(d) {
    const isExpanded = DomainsPage._expanded === d.id;
    const count      = d.record_count || 0;
    return `
      <div class="compose-card domain-card" id="domain-card-${d.id}">
        <div class="compose-card-header" onclick="DomainsPage.toggle(${d.id})">
          <span class="domain-globe">⊕</span>
          <div class="compose-info">
            <span class="compose-name mono">${App.esc(d.name)}</span>
            <span class="compose-meta">${count} subdomain${count !== 1 ? 's' : ''}${d.description ? ' · ' + App.esc(d.description) : ''}</span>
          </div>
          <div class="compose-card-actions" onclick="event.stopPropagation()">
            <button class="btn btn-secondary btn-sm" onclick="DomainsPage.openEditModal(${d.id})">Edit</button>
            <button class="btn btn-danger btn-sm"    onclick="DomainsPage.deleteDomain(${d.id})">Del</button>
          </div>
          <span class="compose-chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>
        ${isExpanded ? `<div id="domain-records-${d.id}"><p style="color:var(--muted);padding:12px 16px;font-size:13px">Loading…</p></div>` : ''}
      </div>`;
  },

  async toggle(id) {
    if (DomainsPage._expanded === id) {
      DomainsPage._expanded = null;
      DomainsPage._render();
      return;
    }
    DomainsPage._expanded = id;
    DomainsPage._render();
    // _render() calls _loadRecords for the expanded item at end
  },

  async _loadRecords(id) {
    const container = document.getElementById(`domain-records-${id}`);
    if (!container) return;
    try {
      const res = await fetch(`/api/v1/domains/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const live = document.getElementById(`domain-records-${id}`);
      if (!live) return;
      live.innerHTML = DomainsPage._recordsHtml(id, data.name, data.records || []);
    } catch (err) {
      const live = document.getElementById(`domain-records-${id}`);
      if (live) live.innerHTML = `<p style="color:var(--danger);padding:12px 16px;font-size:13px">Failed to load: ${App.esc(err.message)}</p>`;
    }
  },

  _recordsHtml(domainId, domainName, records) {
    const rows = records.map(r => {
      const fqdn   = r.subdomain === '@' ? domainName : `${r.subdomain}.${domainName}`;
      const status = r.last_status || null;
      let target, typeBadge;
      if (r.host_id) {
        target    = `${r.host_ip}${r.host_name ? ' — ' + r.host_name : ''}`;
        typeBadge = `<span class="host-type-badge">${r.record_type || 'A'}</span>`;
      } else if (r.compose_id) {
        target    = r.compose_name || `compose #${r.compose_id}`;
        typeBadge = `<span class="host-type-badge">${r.record_type || 'A'}</span>`;
      } else if (r.value) {
        target    = r.value;
        typeBadge = `<span class="host-type-badge">${r.record_type || 'A'}</span>`;
      } else {
        target    = '—';
        typeBadge = '';
      }
      return `
        <tr>
          <td class="mono" style="font-size:12px">${App.esc(fqdn)}</td>
          <td>${typeBadge}</td>
          <td style="font-size:12px;color:var(--text2)">${App.esc(target)}</td>
          <td>${status ? `<span class="status-dot ${status}"></span>` : '<span style="color:var(--muted);font-size:11px">—</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-secondary btn-sm" onclick="DomainsPage.openEditRecordModal(${domainId},'${App.esc(domainName)}',${r.id})">edit</button>
            <button class="btn btn-danger btn-sm"    onclick="DomainsPage.deleteRecord(${domainId},${r.id})">del</button>
          </td>
        </tr>`;
    }).join('');

    return `
      <div class="domain-records-body">
        <div class="compose-services-header" style="display:flex;align-items:center;justify-content:space-between">
          <span class="compose-section-label">Subdomains</span>
          <button class="btn btn-primary btn-sm" onclick="DomainsPage.openAddRecordModal(${domainId},'${App.esc(domainName)}')">+ Add Subdomain</button>
        </div>
        ${records.length
          ? `<table class="domain-table">
               <thead><tr><th>FQDN</th><th>Type</th><th>Target</th><th>Status</th><th></th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
          : '<p style="color:var(--muted);font-size:13px;padding:10px 14px">No subdomains yet — click + Add Subdomain</p>'}
      </div>`;
  },

  // ── Helpers ───────────────────────────────────────────────────────────────

  _hostPickerHtml(selectedId) {
    const allHosts = [];
    for (const [sid, d] of Object.entries(App.hosts)) {
      for (const h of (d.hosts || [])) allHosts.push(h);
    }
    allHosts.sort((a, b) => App._ipToInt(a.ip) - App._ipToInt(b.ip));
    const opts = allHosts.map(h =>
      `<option value="${h.id}" ${h.id == selectedId ? 'selected' : ''}>${h.ip}${h.name ? ' — ' + App.esc(h.name) : ''}</option>`
    ).join('');
    return `
      <div class="compose-host-picker">
        <input type="text" class="compose-host-filter" placeholder="Search IP or name…"
               oninput="DomainsPage._filterSelect(this)" autocomplete="off">
        <select id="m-rec-host">
          <option value="">— none —</option>
          ${opts}
        </select>
      </div>`;
  },

  _composePickerHtml(selectedId) {
    const projs = (typeof ComposePage !== 'undefined' ? ComposePage._projects : []) || [];
    const opts  = projs.map(p =>
      `<option value="${p.id}" ${p.id == selectedId ? 'selected' : ''}>${App.esc(p.name)}</option>`
    ).join('');
    return `<select id="m-rec-compose">
      <option value="">— none —</option>
      ${opts}
    </select>`;
  },

  _filterSelect(input) {
    const q = input.value.toLowerCase();
    const s = input.closest('.compose-host-picker')?.querySelector('select');
    if (!s) return;
    [...s.options].forEach(o => { if (o.value) o.hidden = q.length > 0 && !o.text.toLowerCase().includes(q); });
  },

  _recordFormHtml(domainName, rec) {
    const sub  = rec ? rec.subdomain : '';
    const note = rec ? (rec.notes || '') : '';
    const type = rec ? (rec.record_type || 'A') : 'A';
    const val  = rec ? (rec.value || '') : '';
    const TYPES = ['A','AAAA','CNAME','MX','TXT','NS','SRV','CAA'];
    return `
      <div class="form-group">
        <label>Subdomain *</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="text" id="m-rec-sub" value="${App.esc(sub)}" placeholder="www  api  @" class="mono" style="flex:1">
          <span style="color:var(--muted);font-size:13px">.${App.esc(domainName)}</span>
        </div>
        <span class="hint">Use @ for the root domain itself</span>
      </div>
      <div class="form-group">
        <label>Record Type</label>
        <select id="m-rec-type">
          ${TYPES.map(t => `<option value="${t}" ${t === type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Value / Target <span class="muted">(free-text)</span></label>
        <input type="text" id="m-rec-value" value="${App.esc(val)}" placeholder="e.g. 192.168.1.146  or  http://192.168.1.146:8080  or  target.example.com" class="mono">
        <span class="hint">Any string — IP, URL, hostname. Leave empty if linking to a host below.</span>
      </div>
      <div class="form-group">
        <label>— or — Link to Host (IP address)</label>
        ${DomainsPage._hostPickerHtml(rec?.host_id)}
      </div>
      <div class="form-group">
        <label>— or — Link to Compose Project</label>
        ${DomainsPage._composePickerHtml(rec?.compose_id)}
        <span class="hint">Fill in one of: Value, Host, or Compose project</span>
      </div>
      <div class="form-group">
        <label>Notes <span class="muted">(optional)</span></label>
        <input type="text" id="m-rec-notes" value="${App.esc(note)}" placeholder="e.g. Points to nginx reverse proxy">
      </div>`;
  },

  // ── Domain modals ─────────────────────────────────────────────────────────

  openAddModal() {
    App.openModal(`
      <div class="modal-header">
        <h3>Add Domain</h3>
        <button class="modal-close" onclick="App.closeModal()">×</button>
      </div>
      <div class="form-group">
        <label>Second-level Domain *</label>
        <input type="text" id="m-dom-name" placeholder="example.com" class="mono">
        <span class="hint">e.g. example.com · mylab.local · home.arpa</span>
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="m-dom-desc" placeholder="Optional">
      </div>
      <div class="error-msg hidden" id="m-dom-err"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary"   onclick="DomainsPage.saveDomain()">Add Domain</button>
      </div>
    `);
  },

  openEditModal(id) {
    const d = DomainsPage._domains.find(d => d.id === id);
    if (!d) return;
    App.openModal(`
      <div class="modal-header">
        <h3>Edit Domain</h3>
        <button class="modal-close" onclick="App.closeModal()">×</button>
      </div>
      <div class="form-group">
        <label>Domain Name *</label>
        <input type="text" id="m-dom-name" value="${App.esc(d.name)}" class="mono">
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="m-dom-desc" value="${App.esc(d.description || '')}">
      </div>
      <div class="error-msg hidden" id="m-dom-err"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary"   onclick="DomainsPage.saveDomain(${id})">Save</button>
      </div>
    `);
  },

  async saveDomain(id) {
    const name  = document.getElementById('m-dom-name')?.value.trim();
    const desc  = document.getElementById('m-dom-desc')?.value.trim();
    const errEl = document.getElementById('m-dom-err');
    if (!name) { errEl.textContent = 'Domain name is required'; errEl.classList.remove('hidden'); return; }
    const res = await fetch(id ? `/api/v1/domains/${id}` : '/api/v1/domains', {
      method:  id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, description: desc }),
    });
    if (!res.ok) { const d = await res.json(); errEl.textContent = d.error || 'Failed'; errEl.classList.remove('hidden'); return; }
    App.closeModal();
    App.toast(id ? 'Domain updated' : 'Domain added', 'success');
    DomainsPage.load();
  },

  async deleteDomain(id) {
    const d  = DomainsPage._domains.find(d => d.id === id);
    const ok = await App.confirm(`Delete domain <b>${App.esc(d ? d.name : id)}</b> and all its subdomains?`, { confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const res = await fetch(`/api/v1/domains/${id}`, { method: 'DELETE' });
    if (!res.ok) { App.toast('Failed to delete', 'error'); return; }
    if (DomainsPage._expanded === id) DomainsPage._expanded = null;
    App.toast('Domain deleted', 'success');
    DomainsPage.load();
  },

  // ── Record modals ─────────────────────────────────────────────────────────

  openAddRecordModal(domainId, domainName) {
    App.openModal(`
      <div class="modal-header">
        <h3>Add Subdomain — <span class="mono">${App.esc(domainName)}</span></h3>
        <button class="modal-close" onclick="App.closeModal()">×</button>
      </div>
      ${DomainsPage._recordFormHtml(domainName, null)}
      <div class="error-msg hidden" id="m-rec-err"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary"   onclick="DomainsPage.saveRecord(${domainId})">Add Subdomain</button>
      </div>
    `);
  },

  async openEditRecordModal(domainId, domainName, recordId) {
    let rec;
    try {
      const data = await fetch(`/api/v1/domains/${domainId}`).then(r => r.json());
      rec = data.records?.find(r => r.id === recordId);
    } catch { App.toast('Failed to load record', 'error'); return; }
    if (!rec) { App.toast('Record not found', 'error'); return; }
    App.openModal(`
      <div class="modal-header">
        <h3>Edit Subdomain — <span class="mono">${App.esc(domainName)}</span></h3>
        <button class="modal-close" onclick="App.closeModal()">×</button>
      </div>
      ${DomainsPage._recordFormHtml(domainName, rec)}
      <div class="error-msg hidden" id="m-rec-err"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary"   onclick="DomainsPage.saveRecord(${domainId},${recordId})">Save</button>
      </div>
    `);
  },

  async saveRecord(domainId, recordId) {
    const sub       = document.getElementById('m-rec-sub')?.value.trim() || '@';
    const recType   = document.getElementById('m-rec-type')?.value || 'A';
    const value     = document.getElementById('m-rec-value')?.value.trim() || null;
    const hostEl    = document.getElementById('m-rec-host');
    const composeEl = document.getElementById('m-rec-compose');
    const notes     = document.getElementById('m-rec-notes')?.value.trim();
    const errEl     = document.getElementById('m-rec-err');

    const host_id    = hostEl?.value    ? parseInt(hostEl.value, 10)    : null;
    const compose_id = composeEl?.value ? parseInt(composeEl.value, 10) : null;

    if (!host_id && !compose_id && !value) {
      errEl.textContent = 'Fill in a Value, select a host, or select a compose project';
      errEl.classList.remove('hidden');
      return;
    }

    const url    = recordId ? `/api/v1/domains/${domainId}/records/${recordId}` : `/api/v1/domains/${domainId}/records`;
    const method = recordId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: sub, record_type: recType, value, host_id, compose_id, notes: notes || null }),
    });
    if (!res.ok) { const d = await res.json(); errEl.textContent = d.error || 'Failed'; errEl.classList.remove('hidden'); return; }
    App.closeModal();
    App.toast(recordId ? 'Subdomain updated' : 'Subdomain added', 'success');
    DomainsPage._loadRecords(domainId);
    DomainsPage.load();
  },

  async deleteRecord(domainId, recordId) {
    const ok = await App.confirm('Delete this subdomain?', { confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const res = await fetch(`/api/v1/domains/${domainId}/records/${recordId}`, { method: 'DELETE' });
    if (!res.ok) { App.toast('Failed to delete', 'error'); return; }
    App.toast('Subdomain deleted', 'success');
    DomainsPage._loadRecords(domainId);
    DomainsPage.load();
  },

  onStatusUpdate(hostId, status) {
    // Status dots in domain records update on next _loadRecords cycle
  },
};
