'use strict';
// The guest cull (RJ 493): guests idle for server.guest_cull_days (remote config, read at every sweep) are deleted
// through the account deletion (RJ 473, storage deleteUser), so their feedback is kept, anonymised.
//
// - Idle: no login, no creation and no credential used for that many days (storage/users.js, IDLE_GUEST). A restore
//   and every hourly session refresh touch a credential's last_used_at, so a guest who plays is never idle.
// - A guest holding a seat (reserved or taken) or a ticket in the match registry is passed by, and so is one who
//   upgraded or came back after the sweep picked it: deleteUser checks again under the row lock.
// - At most BATCH a sweep, lowest id first; the rest wait for the next sweep.
// - The first sweep runs firstMs after start() (5 minutes), then one every everyMs (an hour), by wall clock
//   (setTimeout/setInterval, unref'd). A sweep while the last is still running does nothing.
// - One log line per sweep that culled anything: "[guests] culled <n> idle guest(s)".

const log = require('../log');
const storage = require('../storage');

const FIRST_MS = 5 * 60 * 1000;
const EVERY_MS = 60 * 60 * 1000;
const BATCH = 500;

// config: () => the remote config view. match: the registry (holds(uid)), or null. store: {findIdleGuests,
// deleteUser} (storage/users.js); tests pass their own.
function createGuestCull({ config, match = null, store = storage, logger = log, firstMs = FIRST_MS, everyMs = EVERY_MS, batch = BATCH }) {
  let firstTimer = null;
  let timer = null;
  let inFlight = null;

  async function run() {
    const days = config().server.guest_cull_days;
    let culled = 0;
    let held = 0;
    for (const uid of await store.findIdleGuests({ days, limit: batch })) {
      if (match && match.holds(uid)) {
        held++;
        continue;
      }
      if (await store.deleteUser(uid, { idleGuestDays: days })) culled++;
    }
    if (culled > 0) logger.info(`[guests] culled ${culled} idle guest(s)`);
    return { culled, held };
  }

  // One sweep: {culled, held}, or {skipped: true} while another runs, or {failed: true} after logging why.
  async function sweep() {
    if (inFlight) return { skipped: true };
    inFlight = run();
    try {
      return await inFlight;
    } catch (e) {
      logger.error('[guests] cull failed:', e);
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

module.exports = { createGuestCull, FIRST_MS, EVERY_MS, BATCH };
