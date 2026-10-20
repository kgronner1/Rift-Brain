'use strict';
// RJ 506 over HTTP without a database: POST /v1/session/revoke's checks in order (VALIDATION, RATE_LIMITED per
// credential in a bucket of its own), its one answer for every credential (live, already revoked, unknown or another
// user's), no session needed, no admission, the app gates only, and the log line. The credential store is a stand-in;
// v1.db.test.js drives the real one, and the restore refused after it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { createAdmission } = require('../src/admission/admission');
const { signSession } = require('../src/auth/tokens');

const KEY = 'cd'.repeat(32);
const NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0);
const NOW_SEC = NOW_MS / 1000;
const TOKEN = 'Zx9QwErTy7uIoP1aSdFgHjKl-revoke-me-0123456789a';

const GOOD = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android', 'X-RJ-Install': '6f1c2b8e-0000-4000-8000-000000000001',
};

// live: "uid:token" pairs still live. revoke() marks one revoked, as the UPDATE ... AND revoked_at IS NULL does.
function fakeCredentials(live = [`7:${TOKEN}`]) {
  const calls = [];
  const set = new Set(live);
  return {
    calls,
    set,
    async revoke({ userId, token }) {
      calls.push([userId, token]);
      return set.delete(`${userId}:${token}`);
    },
  };
}

async function startApp(t, { v = defaultView('dev'), credentials = fakeCredentials(), admission } = {}) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(v);
  const env = { ENV: 'dev', SESSION_KEY: KEY };
  const now = () => NOW_MS;
  const v1 = { env, remote, now, credentialStore: credentials };
  if (admission) v1.admission = createAdmission({ env, config: () => remote.current(), now });
  const app = createPublicApp(null, { v1 });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body, { headers = GOOD, path = '/v1/session/revoke' } = {}) => {
    const init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(base + path, init);
    return { status: r.status, headers: r.headers, body: JSON.parse(await r.text()) };
  };
  return { call, lines, credentials };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

const cred = (userId = 7, token = TOKEN) => ({ credential: { user_id: userId, token } });

test('a live credential is revoked: ok {} (200), one log line naming the user and nothing secret', async (t) => {
  const { call, lines, credentials } = await startApp(t);
  const r = await call(cred());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'ok', data: {} });
  assert.deepEqual(credentials.calls, [[7, TOKEN]]);
  assert.equal(credentials.set.size, 0);
  assert.ok(lines.some((l) => l.includes('[session] user 7 revoked a credential')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes(TOKEN)), 'the credential is never logged');
});

test('already revoked, unknown, or another user\'s: the same ok {}, nothing logged', async (t) => {
  const { call, lines, credentials } = await startApp(t);
  const first = await call(cred());
  const again = await call(cred());
  const unknown = await call(cred(7, 'A'.repeat(43)));
  const otherUser = await call(cred(8, TOKEN));
  const asString = await call(cred('7', TOKEN));
  for (const r of [again, unknown, otherUser, asString]) {
    assert.equal(r.status, first.status);
    assert.deepEqual(r.body, first.body, 'the answer says nothing about the credential');
  }
  assert.deepEqual(credentials.calls.map((c) => c[0]), [7, 7, 7, 8, 7], 'a user id as a string of digits is read');
  assert.equal(lines.filter((l) => l.includes('revoked a credential')).length, 1, 'only the one that changed a row is logged');
});

test('no session needed: no bearer, an expired one or garbage is ignored', async (t) => {
  const { call, credentials } = await startApp(t, { credentials: fakeCredentials([`7:${TOKEN}`, '7:b', '7:c']) });
  const expired = signSession({ uid: 7, env: 'dev', nowSec: NOW_SEC - 7200, keyHex: KEY }).token;
  assert.equal(code(await call(cred(7, TOKEN))), 'ok');
  assert.equal(code(await call(cred(7, 'b'), { headers: { ...GOOD, Authorization: `Bearer ${expired}` } })), 'ok');
  assert.equal(code(await call(cred(7, 'c'), { headers: { ...GOOD, Authorization: 'Bearer abc.def' } })), 'ok');
  assert.equal(credentials.set.size, 0);
});

test('an unreadable credential is VALIDATION, before the rate limit and the store', async (t) => {
  const { call, credentials } = await startApp(t);
  for (const b of [{}, { credential: 'x' }, cred(0), cred('x'), cred(-1), cred(7, ''), cred(7, 5), cred(7, 't'.repeat(257)),
    { credential: { token: TOKEN } }, { credential: { user_id: 7 } }]) {
    const r = await call(b);
    assert.equal(code(r), 'VALIDATION', JSON.stringify(b));
    assert.equal(r.body.error.message, "That sign-in couldn't be read. Please sign in again.");
    assert.equal(r.body.error.scope, 'request');
  }
  assert.equal(credentials.calls.length, 0);
});

test('rate limited per credential at restore_per_min_credential, in a bucket apart from the restore', async (t) => {
  const v = defaultView('dev');
  v.server.rate_limits.restore_per_min_credential = 2;
  const { call, credentials } = await startApp(t, { v });
  assert.equal(code(await call(cred())), 'ok');
  assert.equal(code(await call(cred())), 'ok');
  const r = await call(cred());
  assert.equal(code(r), 'RATE_LIMITED');
  assert.equal(r.status, 429);
  assert.equal(r.body.error.retry.kind, 'after');
  assert.ok(r.headers.get('retry-after'));
  assert.equal(credentials.calls.length, 2, 'refused in front of the store');
  assert.equal(code(await call(cred(7, 'another-token'))), 'ok', 'another credential has its own count');
  // The restore of the same credential still gets past its own limit (into INTERNAL: no database here).
  assert.equal(code(await call(cred(), { path: '/v1/session' })), 'INTERNAL');
});

test('no admission: with the line full, a revoke still goes straight through', async (t) => {
  const v = defaultView('dev');
  Object.assign(v.server.admission, { enabled: true, rate_per_min: 1, burst: 0 });
  const { call } = await startApp(t, { v, admission: true });
  assert.equal(code(await call(cred(), { path: '/v1/session' })), 'queued', 'control: a restore is queued');
  assert.equal(code(await call(cred())), 'ok');
});

test('the app gates bind it; the multiplayer ones do not (not a multiplayer route)', async (t) => {
  const mp = defaultView('dev');
  mp.gates.maintenance = { active: true, scope: 'multiplayer', title: '', message: 'Down for a bit.', ends_at: null };
  mp.gates.min_build_multiplayer = { default: 99999999 };
  const one = await startApp(t, { v: mp });
  assert.equal(code(await one.call(cred())), 'ok');

  const app = defaultView('dev');
  app.gates.maintenance = { active: true, scope: 'app', title: '', message: 'Down for a bit.', ends_at: null };
  const two = await startApp(t, { v: app });
  assert.equal(code(await two.call(cred())), 'MAINTENANCE');
  assert.equal(code(await two.call(cred(), { headers: { ...GOOD, 'X-RJ-Env': 'alpha' } })), 'ENV_MISMATCH');
  assert.equal(two.credentials.calls.length, 0);
});
