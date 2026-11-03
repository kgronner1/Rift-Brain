'use strict';
// The sweep of expired invites (RJ 458; Wobble Planet specs/invite-links.md, 2.4): every mint deletes a few expired
// rows (storage/invites.js), and this deletes the rest on the guest cull's cadence (app.js passes the same
// GUEST_CULL_FIRST_SEC and GUEST_CULL_EVERY_SEC): first firstMs after start(), then every everyMs, by wall clock
// (unref'd timers). A sweep while the last still runs does nothing. One log line per sweep that deleted anything.

const log = require('../log');
const storage = require('../storage/invites');

// store: {sweepExpiredInvites({now})} (storage/invites.js); tests pass their own.
function createInviteSweep({ store = storage, logger = log, now = () => Date.now(), firstMs, everyMs }) {
  let firstTimer = null;
  let timer = null;
  let inFlight = null;

  // One sweep: {deleted}, or {skipped: true} while another runs, or {failed: true} after logging why.
  async function sweep() {
    if (inFlight) return { skipped: true };
    inFlight = store.sweepExpiredInvites({ now: now() });
    try {
      const deleted = await inFlight;
      if (deleted > 0) logger.info(`[invites] swept ${deleted} expired invite(s)`);
      return { deleted };
    } catch (e) {
      logger.error('[invites] sweep failed:', e);
      return { failed: true };
    } finally {
      inFlight = null;
    }
  }

  return {
    sweep,
    start() {
      if (firstTimer || timer) return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        sweep();
        timer = setInterval(() => { sweep(); }, everyMs);
        timer.unref();
      }, firstMs);
      firstTimer.unref();
    },
    stop() {
      if (firstTimer) clearTimeout(firstTimer);
      if (timer) clearInterval(timer);
      firstTimer = null;
      timer = null;
    },
  };
}

module.exports = { createInviteSweep };
