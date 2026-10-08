'use strict';
// In-memory rate limits (spec M3), the values from config `server.rate_limits`, read on every request so a publish
// changes them without a restart. A fixed one-minute window per (bucket, key); over the limit -> RATE_LIMITED with
// retry `after` the window's end (and Retry-After). Keys are never raw secrets: a credential is keyed by its hash.
//
// One brain process holds the counts, so a restart forgets them; that is fine for limits measured per minute.

const WINDOW_MS = 60 * 1000;
const SWEEP_ABOVE = 10000;

function createRateLimiter({ now = () => Date.now() } = {}) {
  const windows = new Map();

  function sweep(t) {
    for (const [k, w] of windows) if (t - w.start >= WINDOW_MS) windows.delete(k);
  }

  // Counts one attempt. Returns { ok: true } or { ok: false, retryAfterMs }.
  function hit(bucket, key, limit) {
    const t = now();
    if (windows.size > SWEEP_ABOVE) sweep(t);
    const k = `${bucket}\u0000${key}`;
    let w = windows.get(k);
    if (!w || t - w.start >= WINDOW_MS) {
      w = { start: t, count: 0 };
      windows.set(k, w);
    }
    w.count += 1;
    if (w.count > limit) return { ok: false, retryAfterMs: Math.max(1, w.start + WINDOW_MS - t) };
    return { ok: true };
  }

  return { hit, size: () => windows.size, clear: () => windows.clear() };
}

module.exports = { createRateLimiter, WINDOW_MS };
