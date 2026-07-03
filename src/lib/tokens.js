'use strict';

const crypto = require('crypto');

/**
 * Generate a new API token.
 * Format: smt_ + 48 random hex chars = 52 chars total (192 bits entropy)
 */
function generate() {
  const random = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  return `smt_${random}`;
}

/**
 * Hash a token for storage (SHA-256).
 * We never store the raw token, only the hash.
 */
function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Extract the display prefix from a token.
 * Returns "smt_" + first 8 hex chars (12 chars total)
 * This is shown in the UI to identify tokens without exposing the full token.
 */
function prefix(token) {
  return token.slice(0, 12);
}

module.exports = { generate, hash, prefix };
