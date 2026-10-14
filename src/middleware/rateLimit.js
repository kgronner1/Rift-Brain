'use strict';
// In-memory rate limits (spec M3), the values from config `server.rate_limits`, read on every request so a publish
// changes them without a restart. A fixed one-minute window per (bucket, key); over the limit -> RATE_LIMITED with
// retry `after` the window's end (and Retry-After). Keys are never raw secrets: a credential is keyed by its hash.
//
// One brain process holds the counts, so a restart forgets them; that is fine for limits measured per minute.
//
// A limit can also count over a day (RJ 488, feedback per IP): pass DAY_MS as hit()'s window. It is a fixed 24-hour
// window from the key's first attempt, not the UTC day, and a restart forgets it too (fine for alpha).

const WINDOW_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_ABOVE = 10000;

function createRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map();

  function sweep(t) {
    for (const [k, w] of windows) if (t - w.start >= w.len) windows.delete(k);
  }

  // Counts one attempt. Returns { ok: true } or { ok: false, retryAfterMs }.
  // windowMs: WINDOW_MS (a minute) unless given; one bucket always uses the same window.
  function hit(bucket, key, limit, windowMs = WINDOW_MS) {
    const t = now();
    if (windows.size > SWEEP_ABOVE) sweep(t);
    const k = `${bucket}\u0000${key}`;
    let w = windows.get(k);
    if (!w || t - w.start >= w.len) {
      w = { start: t, count: 0, len: windowMs };
      windows.set(k, w);
    }
    w.count += 1;
    if (w.count > limit) return { ok: false, retryAfterMs: Math.max(1, w.start + w.len - t) };
    return { ok: true };
  }

  return { hit, size: () => windows.size, clear: () => windows.clear() };
}

module.exports = { createRateLimiter, WINDOW_MS, DAY_MS };
