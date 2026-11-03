'use strict';
// The invites table (RJ 458, migrations/0007_invites.sql; Wobble Planet specs/invite-links.md, 2.1-2.4): the mint
// behind POST /v1/me/invites, the lookup behind GET /v1/invites/:id and POST /v1/match/join {mode: "join_user"}, and
// the sweep of expired rows.
//
// - An id is 10 characters of INVITE_ALPHABET (no 0/1/i/l/o), each from crypto.randomInt: about 49.5 bits.
// - Every mint is a new row (each share its own link), live for INVITE_TTL_SEC from the mint.
// - An unknown id, an expired one and one whose inviter was deleted (the foreign key cascades) all look the same.
// - Every time is UTC and comes from the caller as milliseconds, written as 'YYYY-MM-DD HH:MM:SS.mmm' and read back
//   with CAST(... AS CHAR), as storage/feedback.js does: the pool's timezone and the box's TZ never enter into it.
// - Expired rows go at every mint (a few, MINT_SWEEP of them) and in the hourly sweep (invites/sweep.js).

const crypto = require('crypto');
const { getDB } = require('../db');

const INVITE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const INVITE_ID_LENGTH = 10;
const INVITE_ID_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/;
const INVITE_TTL_SEC = 24 * 60 * 60;
const MINT_TRIES = 5;
const MINT_SWEEP = 100;
const SWEEP_BATCH = 5000;

function sqlTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function msFromSql(s) {
  return Date.parse(`${String(s).replace(' ', 'T')}Z`);
}

function newInviteId(randomInt = crypto.randomInt) {
  let id = '';
  for (let i = 0; i < INVITE_ID_LENGTH; i++) id += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return id;
}

// An id as a link or a body carries it: trimmed and lower-cased (the alphabet has no capitals, and a chat app may
// capitalise a link), or null when it cannot be an id at all.
function normalizeInviteId(v) {
  if (typeof v !== 'string') return null;
  const id = v.trim().toLowerCase();
  return INVITE_ID_RE.test(id) ? id : null;
}

// Deletes up to `limit` rows expired at `now`. Returns how many went.
async function sweepExpiredInvites({ db = getDB(), now = Date.now(), limit = SWEEP_BATCH } = {}) {
  const n = Math.max(0, Math.floor(limit));
  if (n === 0) return 0;
  const [r] = await db.execute(`DELETE FROM invites WHERE expires_at <= ? LIMIT ${n}`, [sqlTime(now)]);
  return r.affectedRows;
}

// A new invite for user <userId>: {id, expires_in}, or null when the account no longer exists (the foreign key
// refuses the row). An id that is taken already (a 1 in 10^14 chance) is drawn again.
async function mintInvite(userId, { db = getDB(), now = Date.now(), ttlSec = INVITE_TTL_SEC, randomInt } = {}) {
  await sweepExpiredInvites({ db, now, limit: MINT_SWEEP });
  for (let i = 0; i < MINT_TRIES; i++) {
    const id = newInviteId(randomInt);
    try {
      await db.execute('INSERT INTO invites (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [id, userId, sqlTime(now), sqlTime(now + ttlSec * 1000)]);
      return { id, expires_in: ttlSec };
    } catch (error) {
      if (error && (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW')) return null;
      if (!error || error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  throw new Error(`no free invite id after ${MINT_TRIES} tries`);
}

// The live invite <id> (already normalized): {id, user_id, username, expires_in} (seconds left, at least 1), or null
// when there is none: unknown, expired at `now`, or its inviter gone.
async function findInvite(id, { db = getDB(), now = Date.now() } = {}) {
  if (typeof id !== 'string' || !INVITE_ID_RE.test(id)) return null;
  const [rows] = await db.execute(
    `SELECT i.user_id, u.username, CAST(i.expires_at AS CHAR) AS expires_at
       FROM invites i JOIN users u ON u.user_id = i.user_id
      WHERE i.id = ? AND i.expires_at > ? LIMIT 1`,
    [id, sqlTime(now)],
  );
  if (!rows.length) return null;
  const left = Math.ceil((msFromSql(rows[0].expires_at) - now) / 1000);
  return { id, user_id: Number(rows[0].user_id), username: String(rows[0].username), expires_in: Math.max(1, left) };
}

module.exports = {
  INVITE_ALPHABET, INVITE_ID_LENGTH, INVITE_ID_RE, INVITE_TTL_SEC,
  newInviteId, normalizeInviteId, mintInvite, findInvite, sweepExpiredInvites,
};
