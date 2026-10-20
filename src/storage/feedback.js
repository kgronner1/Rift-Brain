'use strict';
// The feedback table (RJ 488, migrations/0003_feedback.sql): the route's insert, the account deletion's anonymise
// (RJ 473 calls anonymizeFeedbackForUser), and the sheet forwarder's queries (RJ 489, feedback/forwarder.js).
//
// Every time is UTC and comes from the caller as milliseconds, written as 'YYYY-MM-DD HH:MM:SS.mmm' and read back
// with CAST(... AS CHAR): the pool's timezone setting and the box's TZ never enter into it.

const { getDB } = require('../db');

function sqlTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

// '2026-10-14 18:00:00.123' -> '2026-10-14T18:00:00.123Z'
function isoFromSql(s) {
  if (s === null || s === undefined) return null;
  return `${String(s).replace(' ', 'T')}Z`;
}

// row: { id, received_ms, written_at, user_id, username, install_id, build, platform, env, tags: [], message,
// context: {} }. Returns { duplicate, received_at }: a repeat of a stored id (a duplicate-key race included) changes
// nothing and reports the stored row's received_at.
async function insertFeedback(row, db = getDB()) {
  try {
    await db.execute(
      `INSERT INTO feedback (id, received_at, written_at, user_id, username, install_id, build, platform, env,
        tags, message, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, sqlTime(row.received_ms), row.written_at, row.user_id, row.username, row.install_id,
        row.build, row.platform, row.env, row.tags.join(','), row.message, JSON.stringify(row.context)],
    );
    return { duplicate: false, received_at: new Date(row.received_ms).toISOString() };
  } catch (err) {
    if (!err || err.code !== 'ER_DUP_ENTRY') throw err;
    const [rows] = await db.execute('SELECT CAST(received_at AS CHAR) AS received_at FROM feedback WHERE id = ?', [row.id]);
    return { duplicate: true, received_at: rows.length ? isoFromSql(rows[0].received_at) : new Date(row.received_ms).toISOString() };
  }
}

// The username a session's user has now, or null when the account is gone.
async function findFeedbackUser(userId, db = getDB()) {
  const [rows] = await db.execute('SELECT user_id, username FROM users WHERE user_id = ? LIMIT 1', [userId]);
  return rows.length ? { user_id: rows[0].user_id, username: rows[0].username } : null;
}

// RJ 473 calls this when it deletes an account: the account's feedback is kept, with nothing left that names the
// player. One statement: identity columns to NULL, anonymized_at set, and rows the sheet already holds move to
// anon_pending, so the forwarder rewrites their Player cell. Rows still pending simply reach the sheet anonymous; one
// in a batch that is out right now is caught when the batch is confirmed (markSent). Returns the rows changed.
async function anonymizeFeedbackForUser(userId, { db = getDB(), now = Date.now() } = {}) {
  const [r] = await db.execute(
    `UPDATE feedback SET
       sheet_attempts = IF(sheet_state = 'sent', 0, sheet_attempts),
       sheet_next_at = IF(sheet_state = 'sent', NULL, sheet_next_at),
       sheet_state = IF(sheet_state = 'sent', 'anon_pending', sheet_state),
       user_id = NULL, username = NULL, install_id = NULL,
       anonymized_at = ?
     WHERE user_id = ?`,
    [sqlTime(now), userId],
  );
  return r.affectedRows;
}

const SHEET_COLUMNS = `id, CAST(received_at AS CHAR) AS received_at, written_at, user_id, username, build, platform,
  env, tags, message, context, sheet_attempts, CAST(anonymized_at AS CHAR) AS anonymized_at`;

function fromDb(r) {
  return { ...r, received_at: isoFromSql(r.received_at), anonymized_at: isoFromSql(r.anonymized_at) };
}

function placeholders(ids) {
  return ids.map(() => '?').join(', ');
}

// The forwarder's side of the table, over one pool. Every method takes the caller's clock.
function createFeedbackSheetStore(db = getDB()) {
  async function due(state, limit, nowMs) {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    const [rows] = await db.query(
      `SELECT ${SHEET_COLUMNS} FROM feedback
       WHERE sheet_state = ? AND (sheet_next_at IS NULL OR sheet_next_at <= ?)
       ORDER BY received_at, id LIMIT ${n}`,
      [state, sqlTime(nowMs)],
    );
    return rows.map(fromDb);
  }

  return {
    dueForAppend: (limit, nowMs) => due('pending', limit, nowMs),
    dueForAnonymize: (limit, nowMs) => due('anon_pending', limit, nowMs),

    // Rows the sheet confirmed since sinceMs: what the daily cap counts.
    async sentSince(sinceMs) {
      const [[r]] = await db.query('SELECT COUNT(*) AS n FROM feedback WHERE sheet_sent_at >= ?', [sqlTime(sinceMs)]);
      return Number(r.n);
    },

    // The sheet holds these now. A row anonymised while its batch was out goes to anon_pending, not sent.
    async markSent(ids, nowMs) {
      if (!ids.length) return 0;
      const [r] = await db.query(
        `UPDATE feedback SET sheet_state = IF(anonymized_at IS NULL, 'sent', 'anon_pending'),
           sheet_sent_at = ?, sheet_attempts = 0, sheet_next_at = NULL
         WHERE sheet_state = 'pending' AND id IN (${placeholders(ids)})`,
        [sqlTime(nowMs), ...ids],
      );
      return r.affectedRows;
    },

    async markAnonDone(ids) {
      if (!ids.length) return 0;
      const [r] = await db.query(
        `UPDATE feedback SET sheet_state = 'done_anon', sheet_attempts = 0, sheet_next_at = NULL
         WHERE sheet_state = 'anon_pending' AND id IN (${placeholders(ids)})`,
        ids,
      );
      return r.affectedRows;
    },

    // A failed try: next at now + min(baseSec * 2^attempts, capSec), then attempts + 1. MariaDB applies a single-table
    // UPDATE's assignments left to right, so sheet_next_at reads the attempts before this failure. Only rows still in
    // `state` back off: a row anonymised meanwhile keeps its new state.
    async backoff(ids, state, nowMs, { baseSec, capSec }) {
      if (!ids.length) return 0;
      const [r] = await db.query(
        `UPDATE feedback SET
           sheet_next_at = DATE_ADD(?, INTERVAL LEAST(? * POW(2, LEAST(sheet_attempts, 20)), ?) SECOND),
           sheet_attempts = sheet_attempts + 1
         WHERE sheet_state = ? AND id IN (${placeholders(ids)})`,
        [sqlTime(nowMs), baseSec, capSec, state, ...ids],
      );
      return r.affectedRows;
    },
  };
}

module.exports = {
  insertFeedback, findFeedbackUser, anonymizeFeedbackForUser, createFeedbackSheetStore,
  feedbackSqlTime: sqlTime, feedbackIsoFromSql: isoFromSql,
};
