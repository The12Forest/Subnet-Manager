'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db/schema');

// Prepared statements for API token lookup
const findByHash = db.prepare(`
  SELECT t.id, t.user_id, t.role, t.revoked, u.username
  FROM api_tokens t
  JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = ?
`);
const touchToken = db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?");

function requireAuth(req, res, next) {
  // 1. Try cookie JWT first (existing behavior)
  const cookieToken = req.cookies && req.cookies.token;
  if (cookieToken) {
    try {
      req.user = jwt.verify(cookieToken, config.JWT_SECRET);
      return next();
    } catch {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Session expired' });
    }
  }

  // 2. Try Bearer API token
  const authHeader = (req.headers.authorization || '').trim();
  if (authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.slice(7);

    // Hash the incoming token and look it up
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const row = findByHash.get(tokenHash);

    if (!row) {
      return res.status(401).json({ error: 'Invalid API token' });
    }
    if (row.revoked) {
      return res.status(401).json({ error: 'API token has been revoked' });
    }

    // Update last-used timestamp
    touchToken.run(row.id);

    // Build req.user from the token's associated user and role
    req.user = {
      id:       row.user_id,
      username: row.username,
      role:     row.role,
      authMethod: 'api_token',
    };
    return next();
  }

  // 3. Not authenticated
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = requireAuth;
