'use strict';
// config/remote.js: the brain's tolerant read of its remote config document (spec 4.5, 5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRemoteConfig, mergeDocument, defaultView } = require('../src/config/remote');

const DEV_DOC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'dev.client.v1.json'), 'utf8'));
const quiet = { info() {}, warn() {}, error() {} };

function recorder() {
  const lines = [];
  return { lines, info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
}

function doc(patch = {}) {
  return { ...JSON.parse(JSON.stringify(DEV_DOC)), serial: 5, ...patch };
}

test('the checked-in dev document reads with nothing rejected', () => {
  const { rejected } = mergeDocument(defaultView('dev'), DEV_DOC);
  assert.deepEqual(rejected, []);
});

test('a fetched document replaces the defaults field by field; a bad field keeps the previous value', async () => {
  const d = doc();
  d.gates.min_build = { default: 10, android: 20 };
  d.gates.min_wire = 'two';
  d.server.rate_limits.login_per_min_ip = 0;
  d.server.rate_limits.login_per_min_account = 7;
  d.gates.maintenance.scope = 'galaxy';
  d.messages = { AUTH_INVALID: { message: 'Nope.' }, bad: { message: 'x' } };
  d.future_field = { anything: true };
  const log = recorder();
  const r = createRemoteConfig({ env: 'dev', url: 'https://x', fetchJson: async () => d, log });
  await r.refresh();
  const v = r.current();
  assert.equal(v.serial, 5);
  assert.deepEqual(v.gates.min_build, { default: 10, android: 20 });
  assert.equal(v.gates.min_wire, 1);
  assert.equal(v.gates.maintenance.scope, 'multiplayer');
  assert.deepEqual(v.server.rate_limits, { login_per_min_ip: 10, login_per_min_account: 7, restore_per_min_credential: 30 });
  assert.deepEqual(v.messages, { AUTH_INVALID: { message: 'Nope.' } });
  for (const p of ['gates.min_wire', 'server.rate_limits.login_per_min_ip', 'gates.maintenance.scope', 'messages.bad']) {
    assert.ok(log.lines.some((l) => l.startsWith(`[CONFIG] rejected ${p}`)), p);
  }
  assert.ok(!log.lines.some((l) => l.includes('future_field')), 'unknown fields are ignored');
});

test('another env, another schema, or an older serial is refused whole; a fetch failure keeps the last copy', async () => {
  let next = doc({ serial: 7 });
  const log = recorder();
  const r = createRemoteConfig({ env: 'dev', url: 'https://x', fetchJson: async () => { if (next instanceof Error) throw next; return next; }, log });
  await r.refresh();
  assert.equal(r.current().serial, 7);

  next = doc({ serial: 8, env: 'alpha' });
  next.gates.min_build = { default: 999 };
  await r.refresh();
  assert.equal(r.current().serial, 7);
  assert.equal(r.current().gates.min_build.default, 0);

  next = doc({ serial: 6 });
  next.gates.min_build = { default: 999 };
  await r.refresh();
  assert.equal(r.current().serial, 7, 'a stale edge cannot roll the brain back');

  next = doc({ serial: 9, schema: 2 });
  await r.refresh();
  assert.equal(r.current().serial, 7);

  next = new Error('ECONNREFUSED');
  await r.refresh();
  assert.equal(r.current().serial, 7);
  assert.equal(r.current().source, 'fetched');
  assert.ok(log.lines.some((l) => l.includes('fetch failed (ECONNREFUSED)')));
  assert.ok(log.lines.some((l) => l.includes('not this brain\'s dev')));
  assert.ok(log.lines.some((l) => l.includes('stale edge')));
});

test('no CONFIG_URL: the compiled defaults, the open gates and spec 4.5\'s limits', async () => {
  const r = createRemoteConfig({ env: 'dev', url: null, log: quiet });
  const v = await r.start();
  assert.equal(v.source, 'defaults');
  assert.equal(v.gates.maintenance.active, false);
  assert.deepEqual(v.server.rate_limits, { login_per_min_ip: 10, login_per_min_account: 5, restore_per_min_credential: 30 });
  assert.equal(v.server.admission.session_refresh_grace_sec, 86400);
  r.stop();
});

test('start() fetches once, then polls; stop() ends the polling', async () => {
  let calls = 0;
  const r = createRemoteConfig({ env: 'dev', url: 'https://x', pollMs: 5, log: quiet, fetchJson: async () => { calls += 1; return doc({ serial: calls }); } });
  await r.start();
  assert.equal(calls, 1);
  await new Promise((res) => setTimeout(res, 40));
  r.stop();
  const seen = calls;
  assert.ok(seen >= 2, `polled ${seen} times`);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(calls, seen);
});
