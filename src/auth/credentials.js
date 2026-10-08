'use strict';
// The long-lived device credential {user_id, token} (spec 4.8): token is 32 random bytes, base64url; the database
// keeps only SHA-256(token), one user_credentials row per device, revocable (migrations/0002_hardening.sql).

const crypto = require('crypto');

const PLATFORM_MAX = 16;
const INSTALL_MAX = 64;
const TOKEN_MAX = 256;

function newCredentialToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashCredentialToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isPlausibleToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= TOKEN_MAX;
}

// The columns are NOT NULL and short; a header is whatever the client sent.
function cleanPlatform(p) {
  const s = typeof p === 'string' ? p.trim().toLowerCase() : '';
  return (s || 'unknown').slice(0, PLATFORM_MAX);
}

function cleanInstall(i) {
  return (typeof i === 'string' ? i.trim() : '').slice(0, INSTALL_MAX);
}

// conn: a pool or a connection inside a transaction. Returns the new credential, token in the clear (once).
async function issueCredential(conn, { userId, platform, installId }) {
  const token = newCredentialToken();
  await conn.execute(
    'INSERT INTO user_credentials (user_id, token_hash, platform, install_id, created_at, last_used_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
    [userId, hashCredentialToken(token), cleanPlatform(platform), cleanInstall(installId)],
  );
  return { user_id: userId, token };
}

// The user behind a non-revoked credential, or null. Touches last_used_at.
async function findUserByCredential(db, { userId, token }) {
  const [rows] = await db.execute(
    `SELECT c.id AS credential_id, u.user_id, u.username
     FROM user_credentials c JOIN users u ON u.user_id = c.user_id
     WHERE c.token_hash = ? AND c.user_id = ? AND c.revoked_at IS NULL
     LIMIT 1`,
    [hashCredentialToken(token), userId],
  );
  if (!rows[0]) return null;
  await db.execute('UPDATE user_credentials SET last_used_at = NOW() WHERE id = ?', [rows[0].credential_id]);
  return { user_id: Number(rows[0].user_id), username: rows[0].username };
}

module.exports = {
  newCredentialToken,
  hashCredentialToken,
  isPlausibleToken,
  cleanPlatform,
  cleanInstall,
  issueCredential,
  findUserByCredential,
};
