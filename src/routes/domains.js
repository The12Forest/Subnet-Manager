'use strict';

const express     = require('express');
const db          = require('../db/schema');
const audit       = require('../lib/audit');
const requireAuth = require('../middleware/auth');
const requireRole = require('../middleware/admin');

const router = express.Router();

// ── Domain statements ─────────────────────────────────────────────────────────
const listDomains = db.prepare(`
  SELECT d.id, d.name, d.description, d.updated_at,
         COUNT(dr.id) AS record_count
  FROM domains d
  LEFT JOIN domain_records dr ON dr.domain_id = d.id
  GROUP BY d.id
  ORDER BY d.name ASC
`);
const getDomain    = db.prepare('SELECT * FROM domains WHERE id = ?');
const insertDomain = db.prepare(`
  INSERT INTO domains (name, description, created_at, updated_at)
  VALUES (?, ?, datetime('now'), datetime('now'))
`);
const updateDomain = db.prepare(`
  UPDATE domains SET name=?, description=?, updated_at=datetime('now') WHERE id=?
`);
const deleteDomain = db.prepare('DELETE FROM domains WHERE id = ?');

// ── Record statements ─────────────────────────────────────────────────────────
const getRecords = db.prepare(`
  SELECT dr.id, dr.domain_id, dr.name AS subdomain, dr.record_type, dr.value,
         dr.host_id, dr.compose_id, dr.notes, dr.created_at,
         h.ip AS host_ip, h.name AS host_name, h.last_status,
         cp.name AS compose_name
  FROM domain_records dr
  LEFT JOIN hosts             h  ON h.id  = dr.host_id
  LEFT JOIN compose_projects  cp ON cp.id = dr.compose_id
  WHERE dr.domain_id = ?
  ORDER BY dr.name ASC
`);
const getRecord    = db.prepare('SELECT * FROM domain_records WHERE id = ?');
const insertRecord = db.prepare(`
  INSERT INTO domain_records (domain_id, name, record_type, value, host_id, compose_id, notes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);
const updateRecord = db.prepare(`
  UPDATE domain_records
  SET name=?, record_type=?, value=?, host_id=?, compose_id=?, notes=?
  WHERE id=?
`);
const deleteRecord = db.prepare('DELETE FROM domain_records WHERE id = ?');

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => res.json(listDomains.all()));

router.post('/', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Domain name is required' });
  try {
    const r = insertDomain.run(name.trim().toLowerCase(), description || null);
    const d = getDomain.get(r.lastInsertRowid);
    audit(req.user, 'create', 'domain', d.id, { after: { name: d.name } });
    res.status(201).json(d);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Domain already exists' });
    throw err;
  }
});

router.get('/:id', requireAuth, (req, res) => {
  const d = getDomain.get(parseInt(req.params.id, 10));
  if (!d) return res.status(404).json({ error: 'Domain not found' });
  res.json({ ...d, records: getRecords.all(d.id) });
});

router.put('/:id', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d  = getDomain.get(id);
  if (!d) return res.status(404).json({ error: 'Domain not found' });
  const { name, description } = req.body || {};
  try {
    updateDomain.run(name ? name.trim().toLowerCase() : d.name, description !== undefined ? description : d.description, id);
    audit(req.user, 'update', 'domain', id, { after: { name: name || d.name } });
    res.json(getDomain.get(id));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Domain already exists' });
    throw err;
  }
});

router.delete('/:id', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d  = getDomain.get(id);
  if (!d) return res.status(404).json({ error: 'Domain not found' });
  deleteDomain.run(id);
  audit(req.user, 'delete', 'domain', id, { before: { name: d.name } });
  res.json({ ok: true });
});

// ── Record routes ─────────────────────────────────────────────────────────────

router.post('/:id/records', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const domainId = parseInt(req.params.id, 10);
  if (!getDomain.get(domainId)) return res.status(404).json({ error: 'Domain not found' });
  const { subdomain = '@', record_type, type, value, host_id, compose_id, notes } = req.body || {};
  const recType = record_type || type || 'A';
  if (!host_id && !compose_id && !value) {
    return res.status(400).json({ error: 'One of host_id, compose_id, or value is required' });
  }
  const r = insertRecord.run(
    domainId,
    (subdomain.trim() || '@').toLowerCase(),
    recType,
    value || null,
    host_id || null,
    compose_id || null,
    notes || null
  );
  const rec = db.prepare(`
    SELECT dr.id, dr.name AS subdomain, dr.record_type, dr.value,
           dr.host_id, dr.compose_id, dr.notes,
           h.ip AS host_ip, h.name AS host_name, h.last_status,
           cp.name AS compose_name
    FROM domain_records dr
    LEFT JOIN hosts h ON h.id = dr.host_id
    LEFT JOIN compose_projects cp ON cp.id = dr.compose_id
    WHERE dr.id = ?
  `).get(r.lastInsertRowid);
  res.status(201).json(rec);
});

router.put('/:id/records/:recordId', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const recordId = parseInt(req.params.recordId, 10);
  const rec = getRecord.get(recordId);
  if (!rec || rec.domain_id !== parseInt(req.params.id, 10)) return res.status(404).json({ error: 'Record not found' });
  const { subdomain, record_type, type, value, host_id, compose_id, notes } = req.body || {};
  const recType = record_type || type;
  updateRecord.run(
    subdomain   !== undefined ? ((subdomain.trim() || '@').toLowerCase()) : rec.name,
    recType !== undefined ? recType  : rec.record_type,
    value       !== undefined ? (value || null) : rec.value,
    host_id     !== undefined ? (host_id    || null) : rec.host_id,
    compose_id  !== undefined ? (compose_id || null) : rec.compose_id,
    notes       !== undefined ? (notes      || null) : rec.notes,
    recordId
  );
  res.json(getRecord.get(recordId));
});

router.delete('/:id/records/:recordId', requireAuth, requireRole('admin', 'editor'), (req, res) => {
  const recordId = parseInt(req.params.recordId, 10);
  const rec = getRecord.get(recordId);
  if (!rec || rec.domain_id !== parseInt(req.params.id, 10)) return res.status(404).json({ error: 'Record not found' });
  deleteRecord.run(recordId);
  res.json({ ok: true });
});

module.exports = router;
