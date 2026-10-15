'use strict';
// RJ 493's remote config keys (flags.guest_play, server.guest_cull_days, server.rate_limits.guest_per_day_ip) in both
// readers and both sources, and the cull's two settings in the environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateDocument } = require('../src/config/remoteSchema');
const { mergeDocument, defaultView } = require('../src/config/remote');
const { loadEnv } = require('../src/config/env');

const good = (env) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', `${env}.client.v1.json`), 'utf8'));

test('both sources carry the keys at the spec\'s defaults, and the compiled defaults match', () => {
  for (const env of ['dev', 'alpha']) {
    const d = good(env);
    assert.deepEqual([d.flags.guest_play, d.server.guest_cull_days, d.server.rate_limits.guest_per_day_ip], [true, 7, 20], env);
    assert.deepEqual(validateDocument(d, { env }).problems, [], env);
  }
  const v = defaultView('dev');
  assert.deepEqual([v.flags.guest_play, v.server.guest_cull_days, v.server.rate_limits.guest_per_day_ip], [true, 7, 20]);
});

test('the strict check: each key required, typed and clamped', () => {
  const at = (fn) => {
    const d = good('dev');
    fn(d);
    return validateDocument(d, { env: 'dev' }).problems;
  };
  assert.deepEqual(at((d) => { delete d.flags.guest_play; }), ['flags.guest_play: is missing']);
  assert.match(at((d) => { d.flags.guest_play = 1; })[0], /^flags\.guest_play: must be true or false/);
  assert.deepEqual(at((d) => { d.flags.guest_play = false; }), []);
  assert.deepEqual(at((d) => { delete d.server.guest_cull_days; }), ['server.guest_cull_days: is missing']);
  assert.deepEqual(at((d) => { d.server.guest_cull_days = 1; }), []);
  assert.deepEqual(at((d) => { d.server.guest_cull_days = 365; }), []);
  assert.match(at((d) => { d.server.guest_cull_days = 0; })[0], /^server\.guest_cull_days: must be at least 1/);
  assert.match(at((d) => { d.server.guest_cull_days = 366; })[0], /must be at most 365/);
  assert.match(at((d) => { d.server.guest_cull_days = 7.5; })[0], /^server\.guest_cull_days/);
  assert.deepEqual(at((d) => { delete d.server.rate_limits.guest_per_day_ip; }), ['server.rate_limits.guest_per_day_ip: is missing']);
  assert.match(at((d) => { d.server.rate_limits.guest_per_day_ip = 0; })[0], /must be at least 1/);
  assert.deepEqual(at((d) => { d.server.rate_limits.guest_per_day_ip = 1000000; }), []);
  assert.match(at((d) => { d.server.rate_limits.guest_per_day_ip = 1000001; })[0], /must be at most 1000000/);
});

test('the tolerant reader: an older document without the keys keeps the defaults; a bad value keeps the last', () => {
  const old = good('dev');
  delete old.flags.guest_play;
  delete old.server.guest_cull_days;
  delete old.server.rate_limits.guest_per_day_ip;
  const a = mergeDocument(defaultView('dev'), old);
  assert.deepEqual(a.rejected, []);
  assert.deepEqual([a.view.flags.guest_play, a.view.server.guest_cull_days, a.view.server.rate_limits.guest_per_day_ip], [true, 7, 20]);

  const next = good('dev');
  next.flags.guest_play = false;
  next.server.guest_cull_days = 30;
  next.server.rate_limits.guest_per_day_ip = 5;
  const b = mergeDocument(a.view, next);
  assert.deepEqual([b.view.flags.guest_play, b.view.server.guest_cull_days, b.view.server.rate_limits.guest_per_day_ip], [false, 30, 5]);

  next.flags.guest_play = 'no';
  next.server.guest_cull_days = 400;
  const c = mergeDocument(b.view, next);
  assert.deepEqual([c.view.flags.guest_play, c.view.server.guest_cull_days], [false, 30]);
  assert.deepEqual(c.rejected.map((r) => r.split(':')[0]).sort(), ['flags.guest_play', 'server.guest_cull_days']);
});

test('GUEST_CULL_FIRST_SEC and GUEST_CULL_EVERY_SEC: 300 and 3600 unless set; a bad value refuses to boot', () => {
  const base = { MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'd' };
  const e = loadEnv(base);
  assert.deepEqual([e.GUEST_CULL_FIRST_SEC, e.GUEST_CULL_EVERY_SEC], [300, 3600]);
  const short = loadEnv({ ...base, GUEST_CULL_FIRST_SEC: '0', GUEST_CULL_EVERY_SEC: ' 5 ' });
  assert.deepEqual([short.GUEST_CULL_FIRST_SEC, short.GUEST_CULL_EVERY_SEC], [0, 5]);
  for (const [k, v] of [['GUEST_CULL_EVERY_SEC', '0'], ['GUEST_CULL_FIRST_SEC', '-1'], ['GUEST_CULL_FIRST_SEC', '1.5'], ['GUEST_CULL_EVERY_SEC', '86401']]) {
    assert.throws(() => loadEnv({ ...base, [k]: v }), new RegExp(`${k} must be a whole number of seconds`), `${k}=${v}`);
  }
});
