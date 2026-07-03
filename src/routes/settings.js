'use strict';

const express     = require('express');
const db          = require('../db/schema');
const config      = require('../config');
const audit       = require('../lib/audit');
const requireAuth = require('../middleware/auth');
const requireRole = require('../middleware/admin');

const router = express.Router();

// Map setting keys to their env var names
const ENV_KEY_MAP = {
  app_name:               'APP_NAME',
  bind_host:              'BIND_HOST',
  port:                   'PORT',
  mcp_port:               'MCP_PORT',
  check_interval:         'CHECK_INTERVAL',
  check_enabled:          'CHECK_ENABLED',
  check_timeout:          'CHECK_TIMEOUT',
  max_users:              'MAX_USERS',
  session_timeout:        'SESSION_TIMEOUT',
  network_mode:           'NETWORK_MODE',
  theme_default:          'THEME_DEFAULT',
  mcp_oauth_client_id:    'MCP_OAUTH_CLIENT_ID',
  mcp_oauth_client_secret:'MCP_OAUTH_CLIENT_SECRET',
};

// Map setting keys to their seed defaults (fallback when no env or DB override)
const SEED_DEFAULTS = {
  app_name:               'Subnet Manager',
  bind_host:              '0.0.0.0',
  port:                   '3000',
  mcp_port:               '3001',
  check_interval:         '60',
  check_enabled:          'true',
  check_timeout:          '2000',
  max_users:              '0',
  session_timeout:        '3600',
  network_mode:           'bridge',
  theme_default:          'dark',
  mcp_oauth_client_id:    'claude-client',
  mcp_oauth_client_secret:'',
};

function getEnvValue(key) {
  const envKey = ENV_KEY_MAP[key] || key.toUpperCase();
  return (envKey in process.env) ? process.env[envKey] : null;
}

const SENSITIVE_KEYS = new Set(['mcp_oauth_client_secret']);

function enrichSetting(row, userRole) {
  const envValue  = getEnvValue(row.key);
  const redact    = SENSITIVE_KEYS.has(row.key) && userRole !== 'admin';
  return {
    ...row,
    value:     redact ? '' : row.value,
    env_value: redact ? null : envValue,
    from_env:  !redact && envValue !== null && row.value === envValue,
    has_env:   envValue !== null,
  };
}

const listSettings  = db.prepare('SELECT * FROM settings ORDER BY key ASC');
const getSetting    = db.prepare('SELECT * FROM settings WHERE key = ?');
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

router.get('/', requireAuth, (req, res) => {
  res.json(listSettings.all().map(r => enrichSetting(r, req.user.role)));
});

router.get('/about', requireAuth, (req, res) => {
  const result = {
    version:  process.env.APP_VERSION || 'dev',
    port:     config.PORT,
    mcp_port: config.MCP_PORT,
  };
  if (req.user.role === 'admin') {
    result.mcp_token   = config.MCP_TOKEN || '';
    // Include API tokens list (without hashes or raw values)
    result.api_tokens = db.prepare(`
      SELECT id, name, prefix, role, created_at, last_used_at, revoked
      FROM api_tokens ORDER BY created_at DESC
    `).all();
  }
  res.json(result);
});

router.get('/:key', requireAuth, (req, res) => {
  const row = getSetting.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Setting not found' });
  res.json(enrichSetting(row, req.user.role));
});

router.put('/:key', requireAuth, requireRole('admin'), (req, res) => {
  const { key }   = req.params;
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value is required' });

  const existing = getSetting.get(key);
  upsertSetting.run(key, String(value));
  audit(req.user, 'update', 'setting', key, {
    before: existing ? existing.value : null,
    after:  String(value),
  });
  res.json(enrichSetting(getSetting.get(key)));
});

// Reset a setting to its env value (or seed default if no env var)
router.delete('/:key/override', requireAuth, requireRole('admin'), (req, res) => {
  const { key } = req.params;
  const resetTo = getEnvValue(key) ?? SEED_DEFAULTS[key] ?? '';
  const existing = getSetting.get(key);
  upsertSetting.run(key, resetTo);
  audit(req.user, 'update', 'setting', key, {
    before: existing ? existing.value : null,
    after:  resetTo,
    note:   'reset to env/default',
  });
  res.json(enrichSetting(getSetting.get(key)));
});

// Bulk update — only known keys accepted
const ALLOWED_KEYS = new Set(Object.keys(ENV_KEY_MAP).concat([
  'setup_complete', 'mcp_enabled', 'base_network', 'base_cidr', 'app_name', 'theme_default',
  'backup_enabled', 'backup_interval_hours', 'backup_max_count', 'backup_last_run',
]));

router.put('/', requireAuth, requireRole('admin'), (req, res) => {
  const updates = req.body || {};
  const results = {};
  const bulkUpdate = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      upsertSetting.run(key, String(value));
      audit(req.user, 'update', 'setting', key, { after: String(value) });
      results[key] = String(value);
    }
  });
  bulkUpdate();
  res.json({ ok: true, updated: results });
});

module.exports = router;
