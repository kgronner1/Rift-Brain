'use strict';
// The feedback forwarder (RJ 489; Wobble Planet specs/player-feedback.md, "The forwarder"): copies feedback rows from
// the database, the source of truth, to the Player Feedback sheet through the Apps Script web app
// (ops/feedback/apps_script.gs), and rewrites the Player cell of rows whose account was deleted since.
//
// Every tick (30 s by wall clock, an unref'd setInterval; skipped while the last is still running):
//   1. append     up to BATCH `pending` rows that are due, oldest first, within server.feedback_sheet_per_day (counted
//                 from sheet_sent_at since UTC midnight). The ids the script confirms become `sent`, or `anon_pending`
//                 when the row was anonymised while the batch was out.
//   2. anonymize  up to BATCH due `anon_pending` rows; the ids confirmed become `done_anon`.
// A failure (a network error, the 20 s timeout, a non-2xx, a body that is not JSON such as Google's HTML error page,
// ok:false) backs the batch off: next try at now + min(30 s * 2^attempts, 1 h), and one log line. An id the script did
// not confirm backs off the same way. Nothing here ever touches a /v1 request.
//
// The request: POST {secret, op: "append" | "anonymize", rows: [{header: value}]}; the answer {ok: true, ids: [...]}.
// Node 20's fetch follows the web app's 302 to script.googleusercontent.com as a GET, which returns the output of the
// /exec run that has already happened.

const log = require('../log');
const { sheetRow } = require('./sheetRow');

const INTERVAL_MS = 30 * 1000;
const TIMEOUT_MS = 20 * 1000;
const BATCH = 20;
const BACKOFF = Object.freeze({ baseSec: 30, capSec: 3600 });
const DAY_MS = 24 * 60 * 60 * 1000;

class SheetError extends Error {}

function backoffSec(attempts, { baseSec, capSec } = BACKOFF) {
  return Math.min(baseSec * 2 ** Math.min(attempts, 20), capSec);
}

// url, secret: env.FEEDBACK_SHEET. config: () => the remote config view. store: storage/feedback.js's
// createFeedbackSheetStore(). fetchImpl, now, logger, the timings: tests' own.
function createFeedbackForwarder({ url, secret, config, store, fetchImpl = globalThis.fetch, now = () => Date.now(),
  logger = log, intervalMs = INTERVAL_MS, timeoutMs = TIMEOUT_MS, batch = BATCH, backoff = BACKOFF }) {
  let timer = null;
  let inFlight = null;
  let capLoggedDay = null;

  async function post(op, rows) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, op, rows }),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new SheetError(timedOut ? `no answer in ${timeoutMs} ms` : `network: ${e && e.message ? e.message : e}`);
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new SheetError(`reading the answer: ${e && e.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : e.message}`);
    }
    if (!res.ok) throw new SheetError(`HTTP ${res.status}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new SheetError(`HTTP ${res.status} but not JSON (${/^\s*</.test(text) ? 'an HTML page' : 'unreadable'})`);
    }
    if (!body || body.ok !== true || !Array.isArray(body.ids)) {
      const why = body && typeof body.error === 'string' ? body.error.slice(0, 120) : 'ok is not true';
      throw new SheetError(`refused: ${why}`);
    }
    return new Set(body.ids.filter((id) => typeof id === 'string'));
  }

  // One pass: send `rows` as `op`, mark what was confirmed, back off the rest. Returns {sent, confirmed}.
  async function pass(op, rows, state, payload, mark) {
    if (!rows.length) return { sent: 0, confirmed: 0 };
    const ids = rows.map((r) => r.id);
    const t = now();
    let confirmed;
    try {
      confirmed = await post(op, rows.map(payload));
    } catch (e) {
      if (!(e instanceof SheetError)) throw e;
      await store.backoff(ids, state, now(), backoff);
      logger.warn(`[feedback] ${op} of ${ids.length} failed (${e.message}); next try in ${backoffSec(rows[0].sheet_attempts, backoff)} s`);
      return { sent: ids.length, confirmed: 0 };
    }
    const done = ids.filter((id) => confirmed.has(id));
    const missing = ids.filter((id) => !confirmed.has(id));
    await mark(done, t);
    if (missing.length) {
      await store.backoff(missing, state, now(), backoff);
      logger.warn(`[feedback] ${op}: the sheet confirmed ${done.length} of ${ids.length}; the rest try again later`);
    }
    return { sent: ids.length, confirmed: done.length };
  }

  async function appendPass() {
    const t = now();
    const cap = config().server.feedback_sheet_per_day;
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    const room = cap - await store.sentSince(dayStart);
    if (room <= 0) {
      if (capLoggedDay !== dayStart && (await store.dueForAppend(1, t)).length) {
        capLoggedDay = dayStart;
        logger.warn(`[feedback] the sheet's daily cap (${cap}) is reached; rows wait for the next UTC day`);
      }
      return { sent: 0, confirmed: 0 };
    }
    const rows = await store.dueForAppend(Math.min(batch, room), t);
    return pass('append', rows, 'pending', sheetRow, (ids, at) => store.markSent(ids, at));
  }

  async function anonymizePass() {
    const rows = await store.dueForAnonymize(batch, now());
    return pass('anonymize', rows, 'anon_pending', (r) => ({ 'Feedback ID': r.id }), (ids) => store.markAnonDone(ids));
  }

  async function run() {
    const out = { append: null, anonymize: null };
    try {
      out.append = await appendPass();
      out.anonymize = await anonymizePass();
    } catch (e) {
      logger.error('[feedback] forwarder tick failed:', e);
    }
    return out;
  }

  // One tick; a tick while the last is still running does nothing ({skipped: true}).
  async function tick() {
    if (inFlight) return { skipped: true };
    inFlight = run();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick(); }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createFeedbackForwarder, backoffSec, INTERVAL_MS, TIMEOUT_MS, BATCH, BACKOFF };
