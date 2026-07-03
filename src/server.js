'use strict';

const http         = require('http');
const https        = require('https');
const path         = require('path');
const fs           = require('fs');
const express      = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db/schema');
require('./db/seed');

// For users without env vars set, read PORT/MCP_PORT from DB so UI changes take effect
if (!process.env.PORT) {
  const row = db.prepare("SELECT value FROM settings WHERE key='port'").get();
  if (row && row.value) config.PORT = parseInt(row.value, 10) || 3000;
}
if (!process.env.MCP_PORT) {
  const row = db.prepare("SELECT value FROM settings WHERE key='mcp_port'").get();
  if (row && row.value) config.MCP_PORT = parseInt(row.value, 10) || 3001;
}

const authRouter     = require('./routes/auth');
const wizardRouter   = require('./routes/wizard');
const subnetsRouter  = require('./routes/subnets');   // includes /:subnetId/hosts
const hostsRouter    = require('./routes/hosts');
const usersRouter    = require('./routes/users');
const settingsRouter = require('./routes/settings');
const statusRouter   = require('./routes/status');
const auditRouter    = require('./routes/audit');
const exportRouter   = require('./routes/export');
const composeRouter  = require('./routes/compose');
const domainsRouter  = require('./routes/domains');
const backupRouter   = require('./routes/backup');
const tokensRouter   = require('./routes/tokens');

const { startChecker }         = require('./lib/checker');
const { startBackupScheduler }      = require('./lib/backup');
const { startIconRefreshScheduler } = require('./lib/iconCache');
const mcpServer        = require('./mcp/server');

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (config.HTTPS_MODE !== 'off') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
});

// API routes
app.use('/api/v1/auth',        authRouter);
app.use('/api/v1/wizard',      wizardRouter);
app.use('/api/v1/subnets',     subnetsRouter);   // also handles /subnets/:id/hosts
app.use('/api/v1/hosts',       hostsRouter);     // PUT/DELETE/check by host ID
app.use('/api/v1/users',       usersRouter);
app.use('/api/v1/settings',    settingsRouter);
app.use('/api/v1/status',      statusRouter);
app.use('/api/v1/audit',       auditRouter);
app.use('/api/v1/export',      exportRouter);
app.use('/api/v1/import',      exportRouter);    // POST /import/json handled in exportRouter
app.use('/api/v1/compose',     composeRouter);
app.use('/api/v1/domains',     domainsRouter);
app.use('/api/v1/tokens',     tokensRouter);
app.use('/api/v1/backup',      backupRouter);

// Serve static frontend
const publicDir  = path.join(__dirname, 'public');
const uploadsDir = path.join(path.resolve(config.DATA_DIR), 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── HTTPS / HTTP server factory ─────────────────────────────────────────────

function createServer() {
  const mode = config.HTTPS_MODE;

  if (mode === 'off') {
    return { server: http.createServer(app), tlsOpts: null };
  }

  if (mode === 'self-signed') {
    const certDir  = path.join(path.resolve(config.DATA_DIR), 'certs');
    const certFile = path.join(certDir, 'cert.pem');
    const keyFile  = path.join(certDir, 'key.pem');

    fs.mkdirSync(certDir, { recursive: true });

    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      console.log('[server] Generating self-signed certificate…');
      const selfsigned = require('selfsigned');
      const attrs = [{ name: 'commonName', value: config.HOSTNAME }];
      const pems  = selfsigned.generate(attrs, { days: 825 });
      fs.writeFileSync(certFile, pems.cert,    { mode: 0o644 });
      fs.writeFileSync(keyFile,  pems.private, { mode: 0o600 });
      console.log('[server] WARNING: Self-signed cert generated — browsers will show a security warning.');
    }

    const tlsOpts = {
      cert: fs.readFileSync(certFile),
      key:  fs.readFileSync(keyFile),
    };
    return { server: https.createServer(tlsOpts, app), tlsOpts };
  }

  if (mode === 'custom') {
    if (!config.SSL_CERT_PATH || !config.SSL_KEY_PATH) {
      console.error('[server] FATAL: HTTPS_MODE=custom requires SSL_CERT_PATH and SSL_KEY_PATH');
      process.exit(1);
    }
    if (!fs.existsSync(config.SSL_CERT_PATH)) {
      console.error(`[server] FATAL: Certificate file not found: ${config.SSL_CERT_PATH}`);
      process.exit(1);
    }
    if (!fs.existsSync(config.SSL_KEY_PATH)) {
      console.error(`[server] FATAL: Key file not found: ${config.SSL_KEY_PATH}`);
      process.exit(1);
    }
    const tlsOpts = {
      cert: fs.readFileSync(config.SSL_CERT_PATH),
      key:  fs.readFileSync(config.SSL_KEY_PATH),
    };
    return { server: https.createServer(tlsOpts, app), tlsOpts };
  }

  console.error(`[server] FATAL: Unknown HTTPS_MODE: ${mode}`);
  process.exit(1);
}

// ── Start ────────────────────────────────────────────────────────────────────

const { server, tlsOpts } = createServer();

server.listen(config.PORT, config.BIND_HOST, () => {
  const proto = config.HTTPS_MODE !== 'off' ? 'https' : 'http';
  console.log(`[server] Subnet Manager running at ${proto}://${config.BIND_HOST}:${config.PORT}`);
});

startChecker();
startBackupScheduler();
startIconRefreshScheduler();
mcpServer.start(config.MCP_PORT, tlsOpts);
