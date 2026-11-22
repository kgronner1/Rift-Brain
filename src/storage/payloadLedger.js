'use strict';
// The payload_ledger table (RJ 587, migrations/0009): every change to a player's payload balance is one row, keyed by
// an entry id (`ref`) that counts once per account. user_stats.currency_amount and currency_earned_alltime stay the
// running totals, written in the same transaction as the rows, so they always equal the opening balance (what
// user_stats held at 0009) plus the ledger. The entry rules are src/contract/payload.js.
//
// Every write here leaves user_stats._last_updated as it was, except the single-player sync's own restamp: the
// column is ON UPDATE current_timestamp(), and a restamp would make the brain's row newer than a client's save and
// refuse that client's next single-player sync of its sp_ columns.
//
// Locks are taken in deleteUser's order (users, then user_stats), so an account's delete racing a credit waits for
// it instead of deadlocking.

const crypto = require('crypto');
const { getDB } = require('../db');
const { loadAccoladeColumns, quoteColumn } = require('./columns');
const log = require('../log');
const P = require('../contract/payload');

function echoRef(entry) {
  return entry && typeof entry.ref === 'string' ? entry.ref : null;
}

// The answer for an account that does not exist: nothing applied, every entry rejected.
function noSuchUserAnswer(entries) {
  return {
    balance: 0,
    earned_alltime: 0,
    entries: entries.map((e) => ({ ref: echoRef(e), status: P.STATUS.REJECTED, reason: P.REASON.NO_SUCH_USER })),
  };
}

// The user's two totals, locked for this transaction: {amount, earned} (NULLs read as 0), or {missing: 'user'} when
// the account is gone, or {missing: 'stats'} when it has no user_stats row.
async function lockTotals(conn, userId) {
  const [users] = await conn.execute('SELECT user_id FROM users WHERE user_id = ? LOCK IN SHARE MODE', [userId]);
  if (!users.length) return { missing: 'user' };
  const [rows] = await conn.execute(
    `SELECT COALESCE(currency_amount, 0) AS amount, COALESCE(currency_earned_alltime, 0) AS earned
     FROM user_stats WHERE user_id = ? FOR UPDATE`,
    [userId],
  );
  if (!rows.length) return { missing: 'stats' };
  return { amount: Number(rows[0].amount), earned: Number(rows[0].earned) };
}

// One ledger row. true when it was inserted, false when the account already holds that ref.
async function insertRow(conn, userId, { ref, source, amount, balanceAfter }) {
  try {
    await conn.execute(
      'INSERT INTO payload_ledger (user_id, ref, source, amount, balance_after) VALUES (?, ?, ?, ?, ?)',
      [userId, ref, source, amount, balanceAfter],
    );
    return true;
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') return false;
    throw error;
  }
}

async function refHeld(conn, userId, ref) {
  const [rows] = await conn.execute('SELECT 1 AS held FROM payload_ledger WHERE user_id = ? AND ref = ? LIMIT 1', [userId, ref]);
  return rows.length > 0;
}

function summary(out) {
  const n = { applied: 0, duplicate: 0, rejected: 0, deferred: 0 };
  for (const e of out) n[e.status] += 1;
  return `${n.applied} applied, ${n.duplicate} duplicate, ${n.rejected} rejected, ${n.deferred} deferred`;
}

// Applies a credit call's entries (already shaped by checkEntries) for user <userId>, in one transaction, in the order
// sent. from: 'client' (POST /v1/me/payload/credit) or 'server' (POST /internal/v1/payload/credit), which decides
// the sources allowed. Returns {balance, earned_alltime, entries: [{ref, status, credited?, reason?}]}, one per entry;
// or null when the account is gone (each route answers that its own way). An account with no user_stats row throws,
// as the single-player sync does: nothing is applied, and the call fails rather than telling the client to drop its
// entries.
//   applied     inserted now; credited is what it added (a carry adds max(0, amount - the balance at that point))
//   duplicate   the account already holds that ref; nothing added
//   rejected    invalid (reason); the client drops it
//   deferred    an accolade the account has not recorded yet (user_accolades count < 1); sent again later
async function applyPayloadEntries(userId, entries, { from = 'client', db = getDB() } = {}) {
  const checks = entries.map((e) => P.checkEntry(e, from));
  const keys = [...new Set(checks.filter((c) => c.ok && c.accoladeKey).map((c) => c.accoladeKey))];
  const columns = keys.length ? await loadAccoladeColumns() : new Set();
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (c.ok && c.accoladeKey && !columns.has(c.accoladeKey)) checks[i] = { ok: false, reason: P.REASON.UNKNOWN_ACCOLADE };
  }
  const known = keys.filter((k) => columns.has(k));

  const conn = await db.getConnection();
  let answer;
  try {
    await conn.beginTransaction();
    const totals = await lockTotals(conn, userId);
    if (totals.missing === 'user') {
      await conn.rollback();
      return null;
    }
    if (totals.missing) throw new Error('No matching user stats found.');
    let counts = {};
    if (known.length) {
      const [rows] = await conn.execute(`SELECT ${known.map(quoteColumn).join(', ')} FROM user_accolades WHERE user_id = ?`, [userId]);
      counts = rows[0] || {};
    }

    let amount = totals.amount;
    let earned = totals.earned;
    let inserted = 0;
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const c = checks[i];
      if (!c.ok) {
        out.push({ ref: echoRef(e), status: P.STATUS.REJECTED, reason: c.reason });
        continue;
      }
      if (c.accoladeKey && !(Number(counts[c.accoladeKey]) >= 1)) {
        // A ref already paid is a duplicate even if the count reads 0 now (another device's accolade sync).
        out.push(await refHeld(conn, userId, e.ref)
          ? { ref: e.ref, status: P.STATUS.DUPLICATE }
          : { ref: e.ref, status: P.STATUS.DEFERRED, reason: P.REASON.NOT_RECORDED });
        continue;
      }
      const credited = e.source === 'carry' ? Math.max(0, e.amount - amount) : e.amount;
      if (!(await insertRow(conn, userId, { ref: e.ref, source: e.source, amount: credited, balanceAfter: amount + credited }))) {
        out.push({ ref: e.ref, status: P.STATUS.DUPLICATE });
        continue;
      }
      amount += credited;
      if (credited > 0) earned += credited;
      inserted += 1;
      out.push({ ref: e.ref, status: P.STATUS.APPLIED, credited });
    }
    if (inserted) {
      await conn.execute(
        'UPDATE user_stats SET currency_amount = ?, currency_earned_alltime = ?, _last_updated = _last_updated WHERE user_id = ?',
        [amount, earned, userId],
      );
    }
    await conn.commit();
    answer = { balance: amount, earned_alltime: earned, entries: out };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  if (entries.length) log.info(`[payload] user ${userId} (${from}): ${summary(answer.entries)}; balance ${answer.balance}`);
  return answer;
}

// The single-player sync's write when an older build (Play 0.2.0 and earlier) sends currency_amount and/or
// currency_earned_alltime as absolute values, in one transaction. Today's rule decides whether the client's copy wins
// (its _last_updated newer than the row's); when it does, the sp_ keys are written as sent, each currency key becomes
// GREATEST(current, sent) -- never lower, so an absolute sync cannot erase a server credit -- and any rise is one
// legacy_sync row (amount: currency_amount's rise, 0 when only the all-time total rose). The row is restamped NOW(), as
// the sync always has. keys: filterSpStatsKeys()'s, at least one a currency key. Returns the legacy ref written, or null.
async function applyLegacySpSync(userId, { stats, keys, lastUpdated }, { db = getDB() } = {}) {
  const conn = await db.getConnection();
  let ref = null;
  let rise = 0;
  try {
    await conn.beginTransaction();
    const totals = await lockTotals(conn, userId);
    const [stale] = !totals.missing
      ? await conn.execute('SELECT user_id FROM user_stats WHERE user_id = ? AND UNIX_TIMESTAMP(_last_updated) < ?;', [userId, lastUpdated])
      : [[]];
    if (!stale.length) {
      await conn.rollback();
      return null;
    }
    let amount = totals.amount;
    let earned = totals.earned;
    const fields = [];
    const values = [];
    for (const key of keys) {
      let value = stats[key];
      if (key === 'currency_amount') value = amount = Math.max(totals.amount, Math.round(value));
      else if (key === 'currency_earned_alltime') value = earned = Math.max(totals.earned, Math.round(value));
      fields.push(`${quoteColumn(key)} = ?`);
      values.push(value);
    }
    values.push(userId);
    if (amount > totals.amount || earned > totals.earned) {
      rise = amount - totals.amount;
      ref = `${P.LEGACY_REF_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
      if (!(await insertRow(conn, userId, { ref, source: 'legacy_sync', amount: rise, balanceAfter: amount }))) {
        throw new Error('a generated legacy ref collided');
      }
    }
    await conn.execute(`UPDATE user_stats SET ${fields.join(', ')}, _last_updated = NOW() WHERE user_id = ?;`, values);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  if (ref) log.info(`[payload] user ${userId}: a legacy single-player sync raised the balance by ${rise} (${ref})`);
  return ref;
}

module.exports = {
  applyPayloadEntries,
  applyLegacySpSync,
  noSuchUserAnswer,
};
