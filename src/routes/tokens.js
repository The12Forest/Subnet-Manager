'use strict';

const express     = require('express');
const db          = require('../db/schema');
const audit       = require('../lib/audit');
const requireAuth = require('../middleware/auth');
const requireRole = require('../middleware/admin');
const { generate, hash, prefix } = require('../lib/tokens');

const router = express.Router();

// ── Prepared statements ─────────────────────────────────────────────────────────

const listTokens   = db.prepare(`
  SELECT id, name, prefix, role, created_at, last_used_at, revoked
  FROM api_tokens ORDER BY created_at DESC
`);
const getToken     = db.prepare('SELECT * FROM api_tokens WHERE id = ?');
const insertToken  = db.prepare(`
  INSERT INTO api_tokens (user_id, name, prefix, token_hash, role, created_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
`);
const revokeToken  = db.prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ?');
const deleteToken  = db.prepare('DELETE FROM api_tokens WHERE id = ?');

// ── All routes require auth + admin ─────────────────────────────────────────────

router.use(requireAuth, requireRole('admin'));

// ── List all tokens ────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.json(listTokens.all());
});

// ── Create a new token ─────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Token name is required' });
  }

  const rawToken    = generate();
  const tokenHash   = hash(rawToken);
  const tokenPrefix = prefix(rawToken);

  // Token inherits the role of its creator
  const result = insertToken.run(req.user.id, name.trim(), tokenPrefix, tokenHash, req.user.role);
  const created = getToken.get(result.lastInsertRowid);

  audit(req.user, 'create', 'api_token', created.id, {
    name:   created.name,
    prefix: created.prefix,
  });

  res.status(201).json({
    id:         created.id,
    name:       created.name,
    prefix:     created.prefix,
    role:       created.role,
    created_at: created.created_at,
    revoked:    created.revoked,
    token:      rawToken,  // Raw token — shown only once
  });
});

// ── Roll (rotate) a token ──────────────────────────────────────────────────────

router.post('/:id/roll', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getToken.get(id);
  if (!existing) return res.status(404).json({ error: 'Token not found' });
  if (existing.revoked) return res.status(400).json({ error: 'Cannot roll a revoked token' });

  const rawToken    = generate();
  const tokenHash   = hash(rawToken);
  const tokenPrefix = prefix(rawToken);

  // Transaction: revoke the old token, insert a new one with the same name
  const roll = db.transaction(() => {
    revokeToken.run(id);

    const result = insertToken.run(
      existing.user_id,
      existing.name,
      tokenPrefix,
      tokenHash,
      existing.role
    );
    const created = getToken.get(result.lastInsertRowid);

    audit(req.user, 'roll', 'api_token', existing.id, {
      old_id:  existing.id,
      new_id:  created.id,
      name:    created.name,
      prefix:  created.prefix,
    });

    return created;
  });

  const created = roll();

  res.status(201).json({
    id:         created.id,
    name:       created.name,
    prefix:     created.prefix,
    role:       created.role,
    created_at: created.created_at,
    revoked:    created.revoked,
    token:      rawToken,  // Raw token — shown only once
  });
});

// ── Revoke a token (soft-delete) ───────────────────────────────────────────────

router.post('/:id/revoke', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getToken.get(id);
  if (!existing) return res.status(404).json({ error: 'Token not found' });
  if (existing.revoked) return res.status(400).json({ error: 'Token is already revoked' });

  revokeToken.run(id);

  audit(req.user, 'revoke', 'api_token', id, {
    name:   existing.name,
    prefix: existing.prefix,
  });

  res.json({
    id:      existing.id,
    name:    existing.name,
    prefix:  existing.prefix,
    revoked: 1,
    ok:      true,
  });
});

// ── Delete a token permanently ─────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = getToken.get(id);
  if (!existing) return res.status(404).json({ error: 'Token not found' });

  deleteToken.run(id);

  audit(req.user, 'delete', 'api_token', id, {
    name:   existing.name,
    prefix: existing.prefix,
  });

  res.json({ ok: true });
});

module.exports = router;
