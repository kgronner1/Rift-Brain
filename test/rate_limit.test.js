'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, WINDOW_MS } = require('../src/middleware/rateLimit');

test('a fixed one-minute window per bucket and key', () => {
  let t = 1000;
  const l = createRateLimiter({ now: () => t });
  assert.equal(l.hit('login-ip', '1.2.3.4', 2).ok, true);
  assert.equal(l.hit('login-ip', '1.2.3.4', 2).ok, true);
  t += 10000;
  const over = l.hit('login-ip', '1.2.3.4', 2);
  assert.deepEqual(over, { ok: false, retryAfterMs: WINDOW_MS - 10000 });
  assert.equal(l.hit('login-ip', '5.6.7.8', 2).ok, true, 'another key');
  assert.equal(l.hit('login-account', '1.2.3.4', 2).ok, true, 'another bucket');
  t = 1000 + WINDOW_MS;
  assert.equal(l.hit('login-ip', '1.2.3.4', 2).ok, true, 'a new window');
});

test('a lower limit from a new config applies at once', () => {
  let t = 0;
  const l = createRateLimiter({ now: () => t });
  for (let i = 0; i < 3; i++) l.hit('b', 'k', 10);
  assert.equal(l.hit('b', 'k', 3).ok, false);
});

test('old windows are swept when the map grows', () => {
  let t = 0;
  const l = createRateLimiter({ now: () => t });
  for (let i = 0; i < 10001; i++) l.hit('b', String(i), 5);
  t += WINDOW_MS;
  l.hit('b', 'fresh', 5);
  assert.equal(l.size(), 1);
});
