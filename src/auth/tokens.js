'use strict';
// Tokens (spec 4.8): base64url(payload_json) + "." + base64url(HMAC-SHA256(key, payload_part)).
//
// - base64url is RFC 4648 section 5 without "=" padding.
// - The HMAC's key is the environment key's 32 raw bytes (the .env holds them as 64 hex characters), and its message
//   is the payload part exactly as it appears in the token (its ASCII bytes), so a verifier never re-serialises JSON.
// - Times (iat, exp) are whole seconds since the Unix epoch; a token is expired once now >= exp.
// - Verification takes `nowSec` as a parameter, so fixture tests stay valid forever.
//
// Pure: no database, no clock of its own.

const crypto = require('crypto');

const TOKEN_VERSION = 1;
const SESSION_TTL_SEC = 60 * 60;
const JOIN_TTL_SEC = 60;
const PART_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4096;

function keyBytes(keyHex) {
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('a token key must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

function hmac(keyHex, message) {
  return crypto.createHmac('sha256', keyBytes(keyHex)).update(message, 'utf8').digest();
}

function sign(payload, keyHex) {
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${part}.${hmac(keyHex, part).toString('base64url')}`;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// verify(token, { keyHex, typ, env, nowSec, ignoreExpiry }) ->
//   { ok: true, payload } or { ok: false, reason, payload? }
// reason: 'malformed' | 'signature' | 'typ' | 'version' | 'env' | 'expired'. Checked in that order: nothing in an
// unsigned payload is trusted, and `typ` comes first among the claims, so a token of one type is never accepted as
// another (a session and an admission grant share SESSION_KEY). `payload` comes back with 'expired' (it is
// genuine), never with the earlier reasons.
function verify(token, { keyHex, typ, env, nowSec, ignoreExpiry = false }) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !PART_RE.test(parts[0]) || !PART_RE.test(parts[1])) return { ok: false, reason: 'malformed' };

  const expected = hmac(keyHex, parts[0]);
  const given = Buffer.from(parts[1], 'base64url');
  // The re-encoding check refuses a non-canonical spelling of the same bytes, so one token has one spelling.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)
    || given.toString('base64url') !== parts[1]) return { ok: false, reason: 'signature' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
  if (!isObject(payload)) return { ok: false, reason: 'malformed' };
  if (payload.typ !== typ) return { ok: false, reason: 'typ' };
  if (payload.v !== TOKEN_VERSION) return { ok: false, reason: 'version' };
  if (env !== undefined && payload.env !== env) return { ok: false, reason: 'env' };
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return { ok: false, reason: 'malformed' };
  if (!ignoreExpiry) {
    if (!Number.isFinite(nowSec)) throw new Error('verify() needs nowSec');
    if (nowSec >= payload.exp) return { ok: false, reason: 'expired', payload };
  }
  return { ok: true, payload };
}

function nowSecFrom(nowMs) {
  return Math.floor(nowMs / 1000);
}

// --- session -----------------------------------------------------------------------------------------------------

function signSession({ uid, env, nowSec, keyHex, ttlSec = SESSION_TTL_SEC }) {
  const payload = { v: TOKEN_VERSION, typ: 's', uid, env, iat: nowSec, exp: nowSec + ttlSec };
  return { token: sign(payload, keyHex), expires_in: ttlSec, payload };
}

function verifySession(token, { keyHex, env, nowSec }) {
  return verify(token, { keyHex, typ: 's', env, nowSec });
}

// POST /v1/session with {credential, session}: a refresh when that session's signature is valid (its expiry does
// not matter) and its iat is younger than session_refresh_grace_sec, and it was issued to the credential's user.
// A refresh is exempt from admission (M6).
function isSessionRefresh(sessionToken, { keyHex, env, nowSec, uid, graceSec }) {
  if (typeof sessionToken !== 'string') return false;
  const r = verify(sessionToken, { keyHex, typ: 's', env, nowSec, ignoreExpiry: true });
  if (!r.ok) return false;
  if (uid !== undefined && r.payload.uid !== uid) return false;
  const age = nowSec - r.payload.iat;
  return age >= 0 && age < graceSec;
}

// --- admission grant (M6) ----------------------------------------------------------------------------------------

// {v, typ:"g", ticket, install, env, iat, exp}, signed with SESSION_KEY: redeemed at /v1/session or /v1/accounts by
// the install it names. Spec 4.8's table lists no iat; verify() requires one on every token, so a grant carries it.
function signGrant({ ticket, install, env, nowSec, keyHex, ttlSec }) {
  const payload = { v: TOKEN_VERSION, typ: 'g', ticket, install, env, iat: nowSec, exp: nowSec + ttlSec };
  return { token: sign(payload, keyHex), payload };
}

function verifyGrant(token, { keyHex, env, nowSec }) {
  return verify(token, { keyHex, typ: 'g', env, nowSec });
}

// --- join (M4 issues these; the fixture pins the format now) -----------------------------------------------------

function signJoin({ uid, uname, lobby, wire, fp, env, seat, host, jti, nowSec, keyHex, ttlSec = JOIN_TTL_SEC }) {
  const payload = { v: TOKEN_VERSION, typ: 'j', uid, uname, lobby, wire, fp, env, seat, host, iat: nowSec, exp: nowSec + ttlSec, jti };
  return { token: sign(payload, keyHex), payload };
}

// --- lobby key ---------------------------------------------------------------------------------------------------

// hex HMAC(LOBBY_MASTER_KEY, lobby_id): a restarted brain can verify a lobby it no longer remembers (spec 4.11).
function deriveLobbyKey(masterKeyHex, lobbyId) {
  return hmac(masterKeyHex, String(lobbyId)).toString('hex');
}

module.exports = {
  TOKEN_VERSION,
  SESSION_TTL_SEC,
  JOIN_TTL_SEC,
  sign,
  verify,
  nowSecFrom,
  signSession,
  verifySession,
  isSessionRefresh,
  signGrant,
  verifyGrant,
  signJoin,
  deriveLobbyKey,
};
