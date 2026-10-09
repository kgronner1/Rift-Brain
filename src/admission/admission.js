'use strict';
// The admission queue (spec M6, D7, 4.8): the `admission` kind of spec 4.2's `queued`, served on the same
// /v1/queue/:ticket as M4's lobby-wait tickets (routes/v1/queue.js asks this queue first, then the match registry).
//
// - A token bucket, capacity server.admission.burst, refilled at rate_per_min. Every value is read live from the
//   remote config, so a publish switches admission on or off, or retunes it, with no restart.
// - When enabled and (the bucket is empty or anyone is already waiting), a sign-in that is neither a session refresh
//   nor carrying a valid grant answers `queued`. One ticket per install: asking again returns the same place.
// - The sweep (every 1 s) grants tickets FIFO as tokens refill. A granted ticket's poll answers {grant}, an admission
//   grant token (tokens.js) redeemable for grant_ttl_sec by the install it names. An unredeemed grant lapses and its
//   ticket re-queues at the front. A redeemed grant stays valid to its exp for that install, so a mistyped password
//   after a long wait does not send the player back to the end of the line -- and so its ticket stays too, answering
//   polls with the same {grant} until that exp, then is dropped (never re-queued: it was admitted). The client polls a
//   granted ticket until a session is issued (Net.queue), and a QUEUE_TICKET_INVALID there would drop its grant.
// - A ticket nobody polls for ticket_ttl_sec is dropped; every poll extends it.
// - Idle tickets are passed over (RJ 481). A waiting ticket not polled within the poll_after_ms it was last told, plus
//   IDLE_GRACE_MS, is idle: the sweep grants past it and it is not counted in anyone's position, but it keeps its
//   place, so its next poll makes it live again ahead of everyone who was behind it. A grant nobody collected (its
//   ticket not polled since the grant) gives its token back when it lapses. So a dead client costs the line nothing,
//   and a backgrounded one loses no place to anyone still waiting.
// - enabled: false admits everyone at once, and every waiting ticket is granted on its next poll or sweep.
// - Position and eta never rise for a ticket (a lapsed grant re-queued at the front would otherwise push everyone
//   back by one).
// In memory, single host. Tokens are never logged.

const crypto = require('crypto');
const log = require('../log');
const { signGrant, verifyGrant, nowSecFrom } = require('../auth/tokens');

const SWEEP_MS = 1000;
const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 30000;
const POLL_JITTER = 0.2;
// How late past its poll_after_ms a waiting ticket's poll may be before the sweep passes it over: network latency and
// a client's timer, not a backgrounded app (that pauses polling, and is passed over until it resumes).
const IDLE_GRACE_MS = 15000;
const GRANTED_POLL_DEFAULT_MS = 5000;
const MESSAGE = "Lots of pilots are launching right now. You're in line.";

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// env: {ENV, SESSION_KEY}. config: () => the remote config view (its server.admission).
function createAdmission({ env, config, now = () => Date.now(), random = Math.random, logger = log }) {
  const tickets = new Map(); // id -> ticket
  const byInstall = new Map(); // install -> ticket
  let waiting = []; // FIFO of tickets with no grant
  let tokens = null;
  let lastRefill = null;
  let sweepTimer = null;
  let wasEnabled = null;

  const settings = () => config().server.admission;

  // Tokens accrue at rate_per_min. The bucket is capped at burst only while nobody waits: what accrues while people
  // wait is theirs, and the sweep grants it (then caps), so a burst smaller than a second's worth of rate does not
  // throttle the line to `burst` a second.
  function refill(t) {
    const a = settings();
    if (tokens === null) {
      tokens = a.burst;
    } else if (t > lastRefill) {
      tokens += (t - lastRefill) * (a.rate_per_min / 60000);
    }
    if (!a.enabled) tokens = a.burst; // switched on later, it starts with a full bucket
    else if (waiting.length === 0) tokens = Math.min(tokens, a.burst);
    lastRefill = Math.max(lastRefill === null ? t : lastRefill, t);
  }

  function noteEnabled(enabled) {
    if (wasEnabled !== null && enabled !== wasEnabled) {
      logger.info(`[admission] ${enabled ? 'on' : 'off'} (${waiting.length} waiting)`);
    }
    wasEnabled = enabled;
  }

  function drop(tk) {
    tickets.delete(tk.id);
    if (byInstall.get(tk.install) === tk) byInstall.delete(tk.install);
    const i = waiting.indexOf(tk);
    if (i >= 0) waiting.splice(i, 1);
  }

  function enqueue(install, t) {
    const tk = {
      id: `q_${crypto.randomBytes(16).toString('base64url')}`,
      kind: 'admission', install, createdAt: t, expiresAt: 0,
      grant: null, grantExpSec: 0, collected: false, redeemed: false, lastPosition: Infinity, lastEta: Infinity,
      seenAt: t, pollAfterMs: 0,
    };
    touch(tk, t);
    tickets.set(tk.id, tk);
    byInstall.set(install, tk);
    waiting.push(tk);
    return tk;
  }

  // A poll (or a sign-in) from the ticket's install: it is alive.
  function touch(tk, t) {
    tk.expiresAt = t + settings().ticket_ttl_sec * 1000;
    tk.seenAt = t;
    if (tk.grant) {
      tk.collected = true;
      const c = config().tunables;
      tk.pollAfterMs = (c && c.queue_poll_default_ms) || GRANTED_POLL_DEFAULT_MS;
    }
  }

  function idle(tk, t) {
    return t > tk.seenAt + tk.pollAfterMs + IDLE_GRACE_MS;
  }

  function redeemed(tk) {
    tk.collected = true;
    tk.redeemed = true;
  }

  function grant(tk, t) {
    const i = waiting.indexOf(tk);
    if (i >= 0) waiting.splice(i, 1);
    const g = signGrant({
      ticket: tk.id, install: tk.install, env: env.ENV, nowSec: nowSecFrom(t), keyHex: env.SESSION_KEY,
      ttlSec: settings().grant_ttl_sec,
    });
    tk.grant = g.token;
    tk.grantExpSec = g.payload.exp;
    tk.collected = false;
  }

  // A grant past its exp: an unredeemed one's ticket goes back to the front of the line, a redeemed one's is dropped.
  // One nobody collected hands its token back: no admission was spent on it.
  function lapseIfDue(tk, t) {
    if (tk.grant && nowSecFrom(t) >= tk.grantExpSec) {
      if (tk.redeemed) {
        drop(tk);
        return true;
      }
      if (!tk.collected && settings().enabled) tokens += 1;
      tk.grant = null;
      tk.grantExpSec = 0;
      tk.collected = false;
      waiting.unshift(tk);
      return true;
    }
    return false;
  }

  // 1 + the live tickets ahead of tk (an idle one ahead will be passed over). 0 when tk is not waiting.
  function livePosition(tk, t) {
    let n = 0;
    for (const w of waiting) {
      if (w === tk) return n + 1;
      if (!idle(w, t)) n++;
    }
    return 0;
  }

  function anyLiveWaiting(t) {
    return waiting.some((w) => !idle(w, t));
  }

  function view(tk, t) {
    const a = settings();
    const computed = livePosition(tk, t);
    const position = Math.max(1, Math.min(tk.lastPosition, computed || 1));
    const ratePerSec = a.rate_per_min / 60;
    const owed = Math.max(0, position - (a.enabled ? tokens : position));
    const eta = Math.min(tk.lastEta, Math.ceil(owed / ratePerSec));
    tk.lastPosition = position;
    tk.lastEta = eta;
    const pollBase = clamp((eta * 1000) / 10, POLL_MIN_MS, POLL_MAX_MS);
    const pollAfter = Math.round(pollBase * (1 - POLL_JITTER + 2 * POLL_JITTER * random()));
    tk.pollAfterMs = pollAfter;
    return {
      ticket: tk.id, kind: 'admission', position, eta_sec: eta,
      poll_after_ms: pollAfter,
      expires_in_sec: a.ticket_ttl_sec,
      message: MESSAGE,
    };
  }

  // Whether a sign-in may go ahead. p: {grant, install, refresh}. Returns
  //   {result:'admitted'} | {result:'queued', queued} | {result:'error', code}
  function gate({ grant: grantToken, install, refresh }) {
    const t = now();
    const a = settings();
    noteEnabled(a.enabled);
    refill(t);
    if (!a.enabled || refresh) return { result: 'admitted' };

    if (grantToken !== undefined && grantToken !== null) {
      const r = redeem(grantToken, install, t);
      if (r) return r;
    }

    let mine = install ? byInstall.get(install) : null;
    if (mine && lapseIfDue(mine, t) && mine.redeemed) mine = null;
    if (mine) {
      if (mine.grant) {
        // This install already holds a grant: the request is the redemption.
        redeemed(mine);
        return { result: 'admitted' };
      }
      touch(mine, t);
      return { result: 'queued', queued: view(mine, t) };
    }

    if (!anyLiveWaiting(t) && tokens >= 1) {
      tokens -= 1;
      return { result: 'admitted' };
    }
    if (!install) return { result: 'error', code: 'VALIDATION', message: "This build can't wait in line for online play. Please update." };
    return { result: 'queued', queued: view(enqueue(install, t), t) };
  }

  // A grant sent with a sign-in. null: an expired grant whose ticket is gone, so the request queues as if it had none.
  function redeem(grantToken, install, t) {
    const r = verifyGrant(grantToken, { keyHex: env.SESSION_KEY, env: env.ENV, nowSec: nowSecFrom(t) });
    if (!r.ok && r.reason !== 'expired') return { result: 'error', code: 'QUEUE_TICKET_INVALID' };
    if (!install || r.payload.install !== install) return { result: 'error', code: 'QUEUE_TICKET_INVALID' };
    const tk = tickets.get(r.payload.ticket);
    if (r.ok) {
      if (tk && tk.install === install && tk.grant) redeemed(tk);
      return { result: 'admitted' };
    }
    if (tk && tk.install === install && !(lapseIfDue(tk, t) && tk.redeemed)) {
      if (tk.grant) {
        redeemed(tk);
        return { result: 'admitted' };
      }
      touch(tk, t);
      return { result: 'queued', queued: view(tk, t) };
    }
    return null;
  }

  // GET /v1/queue/:ticket. null: not an admission ticket (the lobby queue may know it).
  function poll(ticketId, install) {
    const tk = tickets.get(ticketId);
    if (!tk) return null;
    if (tk.install !== install) return { result: 'error', code: 'QUEUE_TICKET_INVALID' };
    const t = now();
    const a = settings();
    noteEnabled(a.enabled);
    refill(t);
    if (lapseIfDue(tk, t) && tk.redeemed) return { result: 'error', code: 'QUEUE_TICKET_INVALID' };
    if (!tk.grant && !a.enabled) grant(tk, t);
    touch(tk, t);
    if (tk.grant) return { result: 'ok', data: { grant: tk.grant } };
    return { result: 'queued', queued: view(tk, t) };
  }

  // DELETE /v1/queue/:ticket. null when unknown (as poll).
  function leave(ticketId, install) {
    const tk = tickets.get(ticketId);
    if (!tk) return null;
    if (tk.install !== install) return { result: 'error', code: 'QUEUE_TICKET_INVALID' };
    drop(tk);
    return { result: 'ok', data: {} };
  }

  function sweep() {
    const t = now();
    const a = settings();
    noteEnabled(a.enabled);
    refill(t);

    for (const tk of [...tickets.values()]) {
      if (t >= tk.expiresAt) drop(tk);
    }
    const lapsed = [];
    for (const tk of tickets.values()) {
      if (tk.grant && nowSecFrom(t) >= tk.grantExpSec) lapsed.push(tk);
    }
    lapsed.sort((x, y) => x.createdAt - y.createdAt);
    for (let i = lapsed.length - 1; i >= 0; i--) lapseIfDue(lapsed[i], t);

    if (!a.enabled) {
      for (const tk of [...waiting]) grant(tk, t);
      tokens = Math.min(tokens, a.burst);
      return;
    }
    const due = [];
    for (const tk of waiting) {
      if (tokens < 1) break;
      if (idle(tk, t)) continue;
      tokens -= 1;
      due.push(tk);
    }
    for (const tk of due) grant(tk, t);
    tokens = Math.min(tokens, a.burst);
  }

  return {
    gate, poll, leave, sweep,
    start() {
      if (!sweepTimer) {
        sweepTimer = setInterval(() => {
          try {
            sweep();
          } catch (e) {
            logger.error('[admission] sweep failed:', e);
          }
        }, SWEEP_MS);
        sweepTimer.unref();
      }
    },
    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
    // Tests and diagnostics.
    get tickets() { return tickets; },
    get waiting() { return waiting; },
    get tokens() { return tokens; },
  };
}

module.exports = { createAdmission, SWEEP_MS, POLL_MIN_MS, POLL_MAX_MS, IDLE_GRACE_MS, MESSAGE };
