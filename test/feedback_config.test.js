'use strict';
// RJ 488's remote config keys (flags.feedback, server.rate_limits.feedback_per_min_ip / feedback_per_day_ip,
// server.feedback_sheet_per_day) in both readers, and the rate limiter's day window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateDocument } = require('../src/config/remoteSchema');
const { mergeDocument, defaultView } = require('../src/config/remote');
const { createRateLimiter, WINDOW_MS, DAY_MS } = require('../src/middleware/rateLimit');

const good = (env) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', `${env}.client.v1.json`), 'utf8'));

test('both sources carry the keys at the plan\'s defaults, and the compiled defaults match', () => {
  for (const env of ['dev', 'alpha']) {
    const d = good(env);
    assert.equal(d.flags.feedback, true, env);
    assert.equal(d.server.rate_limits.feedback_per_min_ip, 10, env);
    assert.equal(d.server.rate_limits.feedback_per_day_ip, 200, env);
    assert.equal(d.server.feedback_sheet_per_day, 1000, env);
  }
  const v = defaultView('dev');
  assert.deepEqual([v.flags.feedback, v.server.rate_limits.feedback_per_min_ip, v.server.rate_limits.feedback_per_day_ip,
    v.server.feedback_sheet_per_day], [true, 10, 200, 1000]);
});

test('the strict check: each key required, typed and clamped', () => {
  const at = (fn) => {
    const d = good('dev');
    fn(d);
    return validateDocument(d, { env: 'dev' }).problems;
  };
  assert.deepEqual(at((d) => { delete d.flags.feedback; }), ['flags.feedback: is missing']);
  assert.match(at((d) => { d.flags.feedback = 'yes'; })[0], /^flags\.feedback: must be true or false/);
  assert.deepEqual(at((d) => { delete d.server.feedback_sheet_per_day; }), ['server.feedback_sheet_per_day: is missing']);
  assert.deepEqual(at((d) => { d.server.feedback_sheet_per_day = 0; }), [], '0 forwards nothing');
  assert.match(at((d) => { d.server.feedback_sheet_per_day = 100001; })[0], /must be at most 100000/);
  assert.match(at((d) => { d.server.rate_limits.feedback_per_min_ip = 0; })[0], /^server\.rate_limits\.feedback_per_min_ip: must be at least 1/);
  assert.deepEqual(at((d) => { d.server.rate_limits.feedback_per_day_ip = 1000000; }), []);
  assert.match(at((d) => { d.server.rate_limits.feedback_per_day_ip = 1000001; })[0], /must be at most 1000000/);
});

test('the tolerant reader: an older document without the keys keeps the defaults; a bad value keeps the last', () => {
  const old = good('dev');
  delete old.flags.feedback;
  delete old.server.feedback_sheet_per_day;
  delete old.server.rate_limits.feedback_per_min_ip;
  delete old.server.rate_limits.feedback_per_day_ip;
  const a = mergeDocument(defaultView('dev'), old);
  assert.deepEqual(a.rejected, []);
  assert.deepEqual([a.view.flags.feedback, a.view.server.rate_limits.feedback_per_min_ip,
    a.view.server.rate_limits.feedback_per_day_ip, a.view.server.feedback_sheet_per_day], [true, 10, 200, 1000]);

  const next = good('dev');
  next.flags.feedback = false;
  next.server.feedback_sheet_per_day = 5;
  next.server.rate_limits.feedback_per_min_ip = 3;
  next.server.rate_limits.feedback_per_day_ip = -1;
  const b = mergeDocument(a.view, next);
  assert.deepEqual([b.view.flags.feedback, b.view.server.feedback_sheet_per_day, b.view.server.rate_limits.feedback_per_min_ip,
    b.view.server.rate_limits.feedback_per_day_ip], [false, 5, 3, 200]);
  assert.deepEqual(b.rejected.map((r) => r.split(':')[0]), ['server.rate_limits.feedback_per_day_ip']);
});

test('the rate limiter\'s day window sits beside the minute window, in its own bucket', () => {
  let t = 0;
  const l = createRateLimiter({ now: () => t });
  assert.equal(l.hit('day', 'ip', 2, DAY_MS).ok, true);
  t += 2 * WINDOW_MS;
  assert.equal(l.hit('day', 'ip', 2, DAY_MS).ok, true, 'a minute passing does not reset a day window');
  assert.deepEqual(l.hit('day', 'ip', 2, DAY_MS), { ok: false, retryAfterMs: DAY_MS - 2 * WINDOW_MS });
  for (let i = 0; i < 10001; i++) l.hit('min', String(i), 5);
  t += WINDOW_MS;
  l.hit('min', 'fresh', 5);
  assert.equal(l.size(), 2, 'the sweep drops expired minute windows and keeps the live day window');
  t = DAY_MS;
  assert.equal(l.hit('day', 'ip', 2, DAY_MS).ok, true, 'a new day');
});
