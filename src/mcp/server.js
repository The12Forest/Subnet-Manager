'use strict';

const http    = require('http');
const https   = require('https');
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const db      = require('../db/schema');
const config  = require('../config');
const { isValidIPv4, ipInSubnet } = require('../lib/ipUtils');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Helpers ─────────────────────────────────────────────────────────────────

function getBase(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return `${proto}://${host}`;
}

// In-memory store for authorization codes (short-lived, single-server)
const authCodes = new Map();

// Clean up expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 300000);

// ── OAuth Discovery endpoints (no auth required) ────────────────────────────

// Protected Resource Metadata — tells clients where the auth server lives
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const base = getBase(req);
  res.json({
    resource:                  `${base}/mcp`,
    authorization_servers:     [base],
    bearer_methods_supported:  ['header'],
    scopes_supported:          ['mcp'],
  });
});

// Authorization Server Metadata — describes our OAuth server capabilities
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = getBase(req);
  res.json({
    issuer:                                 base,
    authorization_endpoint:                `${base}/oauth/authorize`,
    token_endpoint:                        `${base}/oauth/token`,
    registration_endpoint:                 `${base}/oauth/register`,
    scopes_supported:                      ['mcp'],
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code', 'client_credentials'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  });
});

// Dynamic client registration — accept and echo back; we validate by matching
// the configured CLIENT_ID/SECRET at token time, not at registration time
app.post('/oauth/register', (req, res) => {
  const body = req.body || {};
  res.status(201).json({
    client_id:              config.MCP_OAUTH_CLIENT_ID,
    client_secret:          config.MCP_OAUTH_CLIENT_SECRET || undefined,
    client_id_issued_at:    Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris:          body.redirect_uris || [],
    token_endpoint_auth_method: body.token_endpoint_auth_method || 'client_secret_post',
    grant_types:            body.grant_types || ['authorization_code'],
    response_types:         body.response_types || ['code'],
  });
});

function isSafeRedirectUri(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Authorization endpoint — auto-approves (this is your personal server)
app.get('/oauth/authorize', (req, res) => {
  const {
    client_id,
    redirect_uri,
    response_type,
    state,
    code_challenge,
    code_challenge_method,
  } = req.query;

  if (!redirect_uri) {
    return res.status(400).send('<h2>Missing redirect_uri</h2>');
  }
  if (!isSafeRedirectUri(redirect_uri)) {
    return res.status(400).send('<h2>Invalid redirect_uri — must be http or https</h2>');
  }
  if (response_type !== 'code') {
    return res.status(400).send('<h2>Only response_type=code is supported</h2>');
  }

  // Generate a short-lived authorization code
  const code = crypto.randomBytes(32).toString('hex');
  authCodes.set(code, {
    clientId:            client_id,
    redirectUri:         redirect_uri,
    codeChallenge:       code_challenge       || null,
    codeChallengeMethod: code_challenge_method || null,
    expiresAt:           Date.now() + 60000,   // 1 minute
  });

  // Immediately redirect back — auto-approve, no consent page needed
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// Token endpoint — exchange code or client credentials for an access token
app.post('/oauth/token', (req, res) => {
  const grantType = req.body.grant_type;

  // ── Client Credentials grant ─────────────────────────────────────────────
  if (grantType === 'client_credentials') {
    const { clientId, clientSecret } = extractClientCredentials(req);

    if (!validateClient(clientId, clientSecret)) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }

    const token = issueToken(clientId);
    return res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
  }

  // ── Authorization Code grant ─────────────────────────────────────────────
  if (grantType === 'authorization_code') {
    const { code, redirect_uri, code_verifier } = req.body;
    const { clientId } = extractClientCredentials(req);

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or not found' });
    }
    authCodes.delete(code);

    // Verify redirect_uri matches
    if (redirect_uri && redirect_uri !== stored.redirectUri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Verify PKCE if code_challenge was provided
    if (stored.codeChallenge) {
      if (!code_verifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier required' });
      }
      const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      if (hash !== stored.codeChallenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
    }

    const sub = clientId || stored.clientId;
    const token = issueToken(sub);
    return res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

function extractClientCredentials(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const sep     = decoded.indexOf(':');
    return {
      clientId:     decodeURIComponent(decoded.slice(0, sep)),
      clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
    };
  }
  return { clientId: req.body.client_id, clientSecret: req.body.client_secret };
}

function getOAuthCredentials() {
  // DB settings take priority over env/config (live-editable from the UI)
  const idRow     = db.prepare("SELECT value FROM settings WHERE key='mcp_oauth_client_id'").get();
  const secretRow = db.prepare("SELECT value FROM settings WHERE key='mcp_oauth_client_secret'").get();
  return {
    clientId:     (idRow     && idRow.value)     || config.MCP_OAUTH_CLIENT_ID,
    clientSecret: (secretRow && secretRow.value) || config.MCP_OAUTH_CLIENT_SECRET,
  };
}

function validateClient(clientId, clientSecret) {
  const creds = getOAuthCredentials();
  const okId     = clientId === creds.clientId;
  const okSecret = !creds.clientSecret || clientSecret === creds.clientSecret;
  return okId && okSecret;
}

function issueToken(sub) {
  return jwt.sign({ sub, scope: 'mcp' }, config.JWT_SECRET, { expiresIn: '1h' });
}

// Health check — no auth
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'subnet-manager-mcp', version: '1.0.0' });
});

// ── Bearer token auth middleware (runs AFTER public endpoints above) ─────────

app.use((req, res, next) => {
  const auth = (req.headers['authorization'] || '').trim();
  if (!auth.startsWith('Bearer ')) {
    return res
      .status(401)
      .setHeader('WWW-Authenticate', `Bearer realm="${getBase(req)}/mcp"`)
      .json({ error: 'Unauthorized — provide Authorization: Bearer <token>' });
  }

  const token = auth.slice(7);

  // 1. Accept the static MCP_TOKEN (Claude Desktop / manual curl) — legacy
  if (token === config.MCP_TOKEN) return next();

  // 2. Accept JWT access tokens issued by our OAuth server
  try {
    jwt.verify(token, config.JWT_SECRET);
    return next();
  } catch {
    // Not a JWT — fall through
  }

  // 3. Accept API tokens from the database
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT id FROM api_tokens WHERE token_hash = ? AND revoked = 0').get(tokenHash);
  if (row) {
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized — token invalid or expired' });
});

// ── MCP session management ───────────────────────────────────────────────────

const sessions = new Map(); // sessionId -> { sseRes: res | null, createdAt: Date.now() }

// Clean up sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 7_200_000;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}, 600_000);

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_subnets',
    description: 'List all configured subnets',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_hosts',
    description: 'List hosts, optionally filtered by subnet ID',
    inputSchema: {
      type: 'object',
      properties: { subnet_id: { type: 'number', description: 'Filter by subnet ID' } },
    },
  },
  {
    name: 'get_host',
    description: 'Get a host by IP address',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string' } },
      required: ['ip'],
    },
  },
  {
    name: 'add_host',
    description: 'Add a new host to a subnet',
    inputSchema: {
      type: 'object',
      properties: {
        subnet_id:   { type: 'number' },
        ip:          { type: 'string' },
        name:        { type: 'string' },
        description: { type: 'string' },
        check_port:  { type: 'number' },
      },
      required: ['subnet_id', 'ip'],
    },
  },
  {
    name: 'update_host',
    description: 'Update host details by IP',
    inputSchema: {
      type: 'object',
      properties: {
        ip:          { type: 'string' },
        name:        { type: 'string' },
        description: { type: 'string' },
        check_port:  { type: 'number' },
        notes:       { type: 'string' },
      },
      required: ['ip'],
    },
  },
  {
    name: 'remove_host',
    description: 'Remove a host by IP',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string' } },
      required: ['ip'],
    },
  },
  {
    name: 'check_status',
    description: 'Check status of one host (by IP) or all hosts',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string', description: 'Omit to check all hosts' } },
    },
  },
  {
    name: 'add_subnet',
    description: 'Add a new subnet',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string' },
        network:     { type: 'string' },
        cidr:        { type: 'number' },
        description: { type: 'string' },
        color:       { type: 'string' },
      },
      required: ['name', 'network'],
    },
  },
  {
    name: 'update_subnet',
    description: 'Update a subnet by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id:          { type: 'number' },
        name:        { type: 'string' },
        description: { type: 'string' },
        color:       { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'remove_subnet',
    description: 'Remove a subnet (and all its hosts) by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'bulk_add_hosts',
    description: 'Add multiple hosts/containers to a subnet in one operation. Duplicate IPs are skipped, not errored. Returns a summary of added, skipped, and failed entries.',
    inputSchema: {
      type: 'object',
      properties: {
        subnet_id: { type: 'number', description: 'Target subnet ID for all hosts' },
        hosts: {
          type: 'array',
          description: 'Array of hosts to add',
          items: {
            type: 'object',
            properties: {
              ip:          { type: 'string',  description: 'IP address (required)' },
              name:        { type: 'string',  description: 'Display name' },
              description: { type: 'string',  description: 'Short description' },
              type:        { type: 'string',  description: 'container | server | reserved | other (default: container)' },
              check_port:  { type: 'number',  description: 'TCP port to monitor (omit for ICMP ping)' },
              notes:       { type: 'string',  description: 'Free-form notes' },
            },
            required: ['ip'],
          },
        },
      },
      required: ['subnet_id', 'hosts'],
    },
  },
  // ── Compose ──────────────────────────────────────────────────────────────
  {
    name: 'list_compose_projects',
    description: 'List all Docker Compose projects with their network group and linked service count',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_compose_project',
    description: 'Get a Compose project by ID — includes YAML content and service→host links',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'add_compose_project',
    description: 'Create a new Docker Compose project',
    inputSchema: {
      type: 'object',
      properties: {
        name:              { type: 'string', description: 'Project name' },
        description:       { type: 'string' },
        content:           { type: 'string', description: 'Raw docker-compose.yml YAML' },
        icon_url:          { type: 'string', description: 'Image URL for the project icon (server will download and cache it)' },
        display_subnet_id: { type: 'number', description: 'Subnet ID to group this project under' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'update_compose_project',
    description: 'Update a Compose project — name, description, YAML, icon URL, or network group',
    inputSchema: {
      type: 'object',
      properties: {
        id:                { type: 'number' },
        name:              { type: 'string' },
        description:       { type: 'string' },
        content:           { type: 'string' },
        icon_url:          { type: 'string', description: 'New icon URL (server downloads and caches it), or null to remove' },
        display_subnet_id: { type: 'number', description: 'Subnet ID to group this project under, or null to ungroup' },
      },
      required: ['id'],
    },
  },
  {
    name: 'remove_compose_project',
    description: 'Delete a Compose project and all its service links',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'set_compose_service_links',
    description: 'Link compose service names to host IPs. Replaces all existing service links.',
    inputSchema: {
      type: 'object',
      properties: {
        compose_id: { type: 'number' },
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              service_name: { type: 'string' },
              host_id:      { type: 'number', description: 'Host DB id (use list_hosts to find IDs)' },
            },
            required: ['service_name'],
          },
        },
      },
      required: ['compose_id', 'links'],
    },
  },

  // ── Domains ───────────────────────────────────────────────────────────────
  {
    name: 'list_domains',
    description: 'List all domains with their record counts and network group',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_domain',
    description: 'Get a domain by ID with all its DNS records',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'add_domain',
    description: 'Create a new second-level domain (e.g. example.com)',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Second-level domain, e.g. example.com' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_domain',
    description: 'Update a domain name or description',
    inputSchema: {
      type: 'object',
      properties: {
        id:          { type: 'number' },
        name:        { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'remove_domain',
    description: 'Delete a domain and all its subdomains',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'add_domain_record',
    description: 'Add a subdomain entry. Link it to either a host IP or a compose project (not both).',
    inputSchema: {
      type: 'object',
      properties: {
        domain_id:  { type: 'number' },
        subdomain:  { type: 'string', description: 'Third-level prefix: "www", "api", "@" for root' },
        host_id:    { type: 'number', description: 'Link to a host IP (use list_hosts to find IDs)' },
        compose_id: { type: 'number', description: 'Link to a compose project (use list_compose_projects)' },
        notes:      { type: 'string' },
      },
      required: ['domain_id'],
    },
  },
  {
    name: 'update_domain_record',
    description: 'Update a subdomain entry',
    inputSchema: {
      type: 'object',
      properties: {
        record_id:  { type: 'number' },
        domain_id:  { type: 'number', description: 'Required to verify ownership' },
        subdomain:  { type: 'string' },
        host_id:    { type: 'number' },
        compose_id: { type: 'number' },
        notes:      { type: 'string' },
      },
      required: ['record_id', 'domain_id'],
    },
  },
  {
    name: 'remove_domain_record',
    description: 'Delete a subdomain entry',
    inputSchema: {
      type: 'object',
      properties: {
        record_id: { type: 'number' },
        domain_id: { type: 'number', description: 'Required to verify ownership' },
      },
      required: ['record_id', 'domain_id'],
    },
  },
  {
    name: 'get_settings',
    description: 'Get all application settings',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_setting',
    description: 'Update a single setting value',
    inputSchema: {
      type: 'object',
      properties: {
        key:   { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'search',
    description: 'Search hosts by IP, name, or description',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_audit_log',
    description: 'Get recent audit log entries',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries to return (default 20)' } },
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

function toolError(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

async function callTool(name, args) {
  try {
    switch (name) {
      case 'list_subnets': {
        const rows = db.prepare(`
          SELECT s.*, COUNT(h.id) AS hosts_count
          FROM subnets s LEFT JOIN hosts h ON h.subnet_id = s.id
          GROUP BY s.id ORDER BY s.display_order ASC
        `).all();
        return toolResult(rows);
      }

      case 'list_hosts': {
        const rows = args.subnet_id
          ? db.prepare('SELECT * FROM hosts WHERE subnet_id = ? ORDER BY ip ASC').all(args.subnet_id)
          : db.prepare('SELECT * FROM hosts ORDER BY subnet_id ASC, ip ASC').all();
        return toolResult(rows);
      }

      case 'get_host': {
        const host = db.prepare('SELECT * FROM hosts WHERE ip = ?').get(args.ip);
        return host ? toolResult(host) : toolError(`Host not found: ${args.ip}`);
      }

      case 'add_host': {
        if (!args.ip || !isValidIPv4(args.ip)) return toolError(`Invalid IP address: ${args.ip}`);
        const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(args.subnet_id);
        if (!subnet) return toolError(`Subnet not found: ${args.subnet_id}`);
        if (!ipInSubnet(args.ip, subnet.network, subnet.cidr)) {
          return toolError(`IP ${args.ip} is not within subnet ${subnet.network}/${subnet.cidr}`);
        }
        try {
          const r = db.prepare(`
            INSERT INTO hosts (subnet_id, ip, name, description, check_port, check_enabled, last_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, 'unknown', datetime('now'), datetime('now'))
          `).run(args.subnet_id, args.ip, args.name || null, args.description || null, args.check_port || null);
          return toolResult(db.prepare('SELECT * FROM hosts WHERE id = ?').get(r.lastInsertRowid));
        } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return toolError(`IP ${args.ip} is already in use`);
          throw err;
        }
      }

      case 'update_host': {
        const host = db.prepare('SELECT * FROM hosts WHERE ip = ?').get(args.ip);
        if (!host) return toolError(`Host not found: ${args.ip}`);
        db.prepare("UPDATE hosts SET name=?, description=?, check_port=?, notes=?, updated_at=datetime('now') WHERE ip=?").run(
          args.name        !== undefined ? args.name        : host.name,
          args.description !== undefined ? args.description : host.description,
          args.check_port  !== undefined ? args.check_port  : host.check_port,
          args.notes       !== undefined ? args.notes       : host.notes,
          args.ip
        );
        return toolResult(db.prepare('SELECT * FROM hosts WHERE ip = ?').get(args.ip));
      }

      case 'remove_host': {
        const host = db.prepare('SELECT * FROM hosts WHERE ip = ?').get(args.ip);
        if (!host) return toolError(`Host not found: ${args.ip}`);
        db.prepare('DELETE FROM hosts WHERE ip = ?').run(args.ip);
        return toolResult({ removed: args.ip });
      }

      case 'check_status': {
        const { checkHost, startCheckerCycle } = require('../lib/checker');
        if (args.ip) {
          const host = db.prepare('SELECT * FROM hosts WHERE ip = ?').get(args.ip);
          if (!host) return toolError(`Host not found: ${args.ip}`);
          const status = await checkHost(host);
          return toolResult({ ip: args.ip, status });
        }
        await startCheckerCycle();
        return toolResult(db.prepare('SELECT ip, last_status FROM hosts').all());
      }

      case 'add_subnet': {
        const r = db.prepare(`
          INSERT INTO subnets (name, network, cidr, description, color, display_order, created_at)
          VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(display_order),-1)+1 FROM subnets), datetime('now'))
        `).run(args.name, args.network, args.cidr || 24, args.description || null, args.color || null);
        return toolResult(db.prepare('SELECT * FROM subnets WHERE id = ?').get(r.lastInsertRowid));
      }

      case 'update_subnet': {
        const s = db.prepare('SELECT * FROM subnets WHERE id = ?').get(args.id);
        if (!s) return toolError(`Subnet not found: ${args.id}`);
        db.prepare('UPDATE subnets SET name=?, description=?, color=? WHERE id=?').run(
          args.name        !== undefined ? args.name        : s.name,
          args.description !== undefined ? args.description : s.description,
          args.color       !== undefined ? args.color       : s.color,
          args.id
        );
        return toolResult(db.prepare('SELECT * FROM subnets WHERE id = ?').get(args.id));
      }

      case 'remove_subnet': {
        const s = db.prepare('SELECT * FROM subnets WHERE id = ?').get(args.id);
        if (!s) return toolError(`Subnet not found: ${args.id}`);
        db.prepare('DELETE FROM subnets WHERE id = ?').run(args.id);
        return toolResult({ removed: args.id });
      }

      case 'bulk_add_hosts': {
        const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(args.subnet_id);
        if (!subnet) return toolError(`Subnet not found: ${args.subnet_id}`);
        if (!Array.isArray(args.hosts) || args.hosts.length === 0) {
          return toolError('hosts must be a non-empty array');
        }

        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO hosts
            (subnet_id, ip, name, description, type, notes, check_port, check_enabled, last_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'unknown', datetime('now'), datetime('now'))
        `);

        const added   = [];
        const skipped = [];
        const failed  = [];

        const run = db.transaction(() => {
          for (const h of args.hosts) {
            if (!h.ip) { failed.push({ ip: '?', reason: 'ip is required' }); continue; }
            try {
              const r = insertStmt.run(
                args.subnet_id,
                h.ip,
                h.name        || null,
                h.description || null,
                h.type        || 'container',
                h.notes       || null,
                h.check_port  || null,
              );
              if (r.changes === 0) {
                skipped.push({ ip: h.ip, reason: 'IP already exists' });
              } else {
                added.push({ id: r.lastInsertRowid, ip: h.ip, name: h.name || null });
              }
            } catch (err) {
              failed.push({ ip: h.ip, reason: err.message });
            }
          }
        });

        run();

        return toolResult({
          subnet:  subnet.name,
          added:   added.length,
          skipped: skipped.length,
          failed:  failed.length,
          details: { added, skipped, failed },
        });
      }

      // ── Compose ────────────────────────────────────────────────────────────
      case 'list_compose_projects': {
        const rows = db.prepare(`
          SELECT cp.id, cp.name, cp.description, cp.icon_url, cp.display_subnet_id, cp.updated_at,
                 s.name AS display_subnet_name,
                 COUNT(DISTINCT CASE WHEN csl.host_id IS NOT NULL THEN csl.id END) AS linked_count
          FROM compose_projects cp
          LEFT JOIN subnets s              ON s.id           = cp.display_subnet_id
          LEFT JOIN compose_service_links csl ON csl.compose_id = cp.id
          GROUP BY cp.id ORDER BY cp.updated_at DESC
        `).all();
        return toolResult(rows);
      }

      case 'get_compose_project': {
        const p = db.prepare('SELECT * FROM compose_projects WHERE id = ?').get(args.id);
        if (!p) return toolError(`Compose project not found: ${args.id}`);
        const links = db.prepare(`
          SELECT csl.service_name, csl.host_id, h.ip, h.name AS host_name, h.last_status
          FROM compose_service_links csl LEFT JOIN hosts h ON h.id = csl.host_id
          WHERE csl.compose_id = ? ORDER BY csl.service_name
        `).all(args.id);
        return toolResult({ ...p, links });
      }

      case 'add_compose_project': {
        const { cacheIcon: _ci } = require('../lib/iconCache');
        const r = db.prepare(`
          INSERT INTO compose_projects (name, description, content, icon_url, display_subnet_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(args.name, args.description || null, args.content, args.icon_url || null, args.display_subnet_id || null);
        const newId = r.lastInsertRowid;
        if (args.icon_url) _ci(newId, args.icon_url).catch(() => {});
        return toolResult(db.prepare('SELECT * FROM compose_projects WHERE id = ?').get(newId));
      }

      case 'update_compose_project': {
        const p = db.prepare('SELECT * FROM compose_projects WHERE id = ?').get(args.id);
        if (!p) return toolError(`Compose project not found: ${args.id}`);
        const newIconUrl = args.icon_url !== undefined ? (args.icon_url || null) : p.icon_url;
        db.prepare(`UPDATE compose_projects SET name=?, description=?, content=?, icon_url=?, display_subnet_id=?, updated_at=datetime('now') WHERE id=?`).run(
          args.name              !== undefined ? args.name              : p.name,
          args.description       !== undefined ? args.description       : p.description,
          args.content           !== undefined ? args.content           : p.content,
          newIconUrl,
          args.display_subnet_id !== undefined ? (args.display_subnet_id || null) : p.display_subnet_id,
          args.id
        );
        if (newIconUrl && newIconUrl !== p.icon_url) {
          const { cacheIcon: _ci } = require('../lib/iconCache');
          _ci(args.id, newIconUrl).catch(() => {});
        }
        return toolResult(db.prepare('SELECT * FROM compose_projects WHERE id = ?').get(args.id));
      }

      case 'remove_compose_project': {
        const p = db.prepare('SELECT * FROM compose_projects WHERE id = ?').get(args.id);
        if (!p) return toolError(`Compose project not found: ${args.id}`);
        db.prepare('DELETE FROM compose_projects WHERE id = ?').run(args.id);
        return toolResult({ removed: args.id, name: p.name });
      }

      case 'set_compose_service_links': {
        const p = db.prepare('SELECT id FROM compose_projects WHERE id = ?').get(args.compose_id);
        if (!p) return toolError(`Compose project not found: ${args.compose_id}`);
        const delLinks = db.prepare('DELETE FROM compose_service_links WHERE compose_id = ?');
        const insLink  = db.prepare(`INSERT OR REPLACE INTO compose_service_links (compose_id, service_name, host_id, created_at) VALUES (?, ?, ?, datetime('now'))`);
        db.transaction(() => {
          delLinks.run(args.compose_id);
          for (const l of (args.links || [])) {
            if (l.service_name) insLink.run(args.compose_id, l.service_name, l.host_id || null);
          }
        })();
        const updated = db.prepare(`
          SELECT csl.service_name, csl.host_id, h.ip, h.name AS host_name
          FROM compose_service_links csl LEFT JOIN hosts h ON h.id = csl.host_id
          WHERE csl.compose_id = ?
        `).all(args.compose_id);
        return toolResult({ compose_id: args.compose_id, links: updated });
      }

      // ── Domains ─────────────────────────────────────────────────────────────
      case 'list_domains': {
        const rows = db.prepare(`
          SELECT d.id, d.name, d.description, d.display_subnet_id, d.updated_at,
                 s.name AS display_subnet_name,
                 COUNT(dr.id) AS record_count
          FROM domains d
          LEFT JOIN subnets        s  ON s.id = d.display_subnet_id
          LEFT JOIN domain_records dr ON dr.domain_id = d.id
          GROUP BY d.id ORDER BY d.name ASC
        `).all();
        return toolResult(rows);
      }

      case 'get_domain': {
        const d = db.prepare('SELECT * FROM domains WHERE id = ?').get(args.id);
        if (!d) return toolError(`Domain not found: ${args.id}`);
        const records = db.prepare(`
          SELECT dr.id, dr.name AS subdomain, dr.host_id, dr.compose_id, dr.notes,
                 h.ip AS host_ip, h.name AS host_name, h.last_status,
                 cp.name AS compose_name
          FROM domain_records dr
          LEFT JOIN hosts            h  ON h.id  = dr.host_id
          LEFT JOIN compose_projects cp ON cp.id = dr.compose_id
          WHERE dr.domain_id = ? ORDER BY dr.name
        `).all(args.id);
        return toolResult({ ...d, records });
      }

      case 'add_domain': {
        if (!args.name) return toolError('name is required');
        try {
          const r = db.prepare(`INSERT INTO domains (name, description, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`).run(args.name.trim().toLowerCase(), args.description || null);
          return toolResult(db.prepare('SELECT * FROM domains WHERE id = ?').get(r.lastInsertRowid));
        } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return toolError(`Domain already exists: ${args.name}`);
          throw err;
        }
      }

      case 'update_domain': {
        const d = db.prepare('SELECT * FROM domains WHERE id = ?').get(args.id);
        if (!d) return toolError(`Domain not found: ${args.id}`);
        try {
          db.prepare(`UPDATE domains SET name=?, description=?, updated_at=datetime('now') WHERE id=?`).run(
            args.name        !== undefined ? args.name.trim().toLowerCase() : d.name,
            args.description !== undefined ? args.description               : d.description,
            args.id
          );
        } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return toolError(`Domain already exists: ${args.name}`);
          throw err;
        }
        return toolResult(db.prepare('SELECT * FROM domains WHERE id = ?').get(args.id));
      }

      case 'remove_domain': {
        const d = db.prepare('SELECT * FROM domains WHERE id = ?').get(args.id);
        if (!d) return toolError(`Domain not found: ${args.id}`);
        db.prepare('DELETE FROM domains WHERE id = ?').run(args.id);
        return toolResult({ removed: args.id, name: d.name });
      }

      case 'add_domain_record': {
        const d = db.prepare('SELECT id FROM domains WHERE id = ?').get(args.domain_id);
        if (!d) return toolError(`Domain not found: ${args.domain_id}`);
        if (!args.host_id && !args.compose_id) return toolError('Either host_id or compose_id is required');
        const sub = ((args.subdomain || '@').trim() || '@').toLowerCase();
        const r = db.prepare(`INSERT INTO domain_records (domain_id, name, record_type, host_id, compose_id, notes, created_at) VALUES (?, ?, 'A', ?, ?, ?, datetime('now'))`).run(
          args.domain_id, sub, args.host_id || null, args.compose_id || null, args.notes || null
        );
        return toolResult(db.prepare('SELECT * FROM domain_records WHERE id = ?').get(r.lastInsertRowid));
      }

      case 'update_domain_record': {
        const rec = db.prepare('SELECT * FROM domain_records WHERE id = ?').get(args.record_id);
        if (!rec || rec.domain_id !== args.domain_id) return toolError(`Record not found: ${args.record_id}`);
        db.prepare('UPDATE domain_records SET name=?, host_id=?, compose_id=?, notes=? WHERE id=?').run(
          args.subdomain   !== undefined ? ((args.subdomain.trim() || '@').toLowerCase()) : rec.name,
          args.host_id     !== undefined ? (args.host_id    || null) : rec.host_id,
          args.compose_id  !== undefined ? (args.compose_id || null) : rec.compose_id,
          args.notes       !== undefined ? (args.notes      || null) : rec.notes,
          args.record_id
        );
        return toolResult(db.prepare('SELECT * FROM domain_records WHERE id = ?').get(args.record_id));
      }

      case 'remove_domain_record': {
        const rec = db.prepare('SELECT * FROM domain_records WHERE id = ?').get(args.record_id);
        if (!rec || rec.domain_id !== args.domain_id) return toolError(`Record not found: ${args.record_id}`);
        db.prepare('DELETE FROM domain_records WHERE id = ?').run(args.record_id);
        return toolResult({ removed: args.record_id });
      }

      case 'get_settings':
        return toolResult(db.prepare('SELECT key, value, description FROM settings ORDER BY key ASC').all());

      case 'update_setting': {
        const MCP_SETTING_ALLOWLIST = new Set([
          'app_name','bind_host','port','mcp_port','check_interval','check_enabled',
          'check_timeout','max_users','session_timeout','network_mode','theme_default',
          'mcp_oauth_client_id','mcp_oauth_client_secret','backup_enabled',
          'backup_interval_hours','backup_max_count',
        ]);
        if (!MCP_SETTING_ALLOWLIST.has(args.key)) return toolError(`Setting key not allowed: ${args.key}`);
        db.prepare(`
          INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        `).run(args.key, String(args.value));
        return toolResult({ key: args.key, value: args.value });
      }

      case 'search': {
        const q = `%${args.query}%`;
        const rows = db.prepare(`
          SELECT h.*, s.name AS subnet_name FROM hosts h
          JOIN subnets s ON s.id = h.subnet_id
          WHERE h.ip LIKE ? OR h.name LIKE ? OR h.description LIKE ?
          ORDER BY h.ip ASC
        `).all(q, q, q);
        return toolResult(rows);
      }

      case 'get_audit_log': {
        const limit = Math.min(100, args.limit || 20);
        return toolResult(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit));
      }

      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return toolError(`Tool error: ${err.message}`);
  }
}

// ── JSON-RPC dispatcher ──────────────────────────────────────────────────────

async function handleRpc(body) {
  const { jsonrpc, id, method, params = {} } = body;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }

  switch (method) {
    case 'initialize': {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { sseRes: null, createdAt: Date.now() });
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'subnet-manager', version: '1.0.0' },
        },
        _sessionId: sessionId,
      };
    }

    case 'notifications/initialized':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const result = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result };
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── MCP routes ───────────────────────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const body      = req.body;

  if (body.method !== 'initialize' && body.method !== 'notifications/initialized') {
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(404).json({ error: 'Session not found — call initialize first' });
    }
  }

  const rpc = await handleRpc(body);

  if (rpc === null) return res.status(202).end();

  if (body.method === 'initialize' && rpc._sessionId) {
    res.setHeader('Mcp-Session-Id', rpc._sessionId);
    delete rpc._sessionId;
  }

  res.json(rpc);
});

app.get('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sessions.get(sessionId).sseRes = res;

  const ping = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    const s = sessions.get(sessionId);
    if (s) s.sseRes = null;
  });
});

app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId) sessions.delete(sessionId);
  res.status(200).json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────────────

function start(port, tlsOpts) {
  const server = tlsOpts && tlsOpts.key && tlsOpts.cert
    ? require('https').createServer(tlsOpts, app)
    : require('http').createServer(app);

  server.listen(port, config.BIND_HOST, () => {
    const proto = tlsOpts ? 'https' : 'http';
    const creds = getOAuthCredentials();
    if (!creds.clientSecret) {
      console.warn('[mcp] WARNING: MCP_OAUTH_CLIENT_SECRET is not set — any client can obtain a token without a secret. Set it in Settings → About or via environment variable.');
    }
    console.log(`[mcp] Server listening on ${config.BIND_HOST}:${port}`);
    console.log(`[mcp] ─────────────────────────────────────────────`);
    console.log(`[mcp] Claude.ai web integration:`);
    console.log(`[mcp]   MCP URL:             ${proto}://<your-public-url>/mcp`);
    console.log(`[mcp]   OAuth Client ID:     ${creds.clientId}`);
    console.log(`[mcp]   OAuth Client Secret: ${creds.clientSecret || '(not set)'}`);
    console.log(`[mcp]   Settings → About tab shows full setup info`);
    console.log(`[mcp] ─────────────────────────────────────────────`);
  });

  return server;
}

module.exports = { start };
