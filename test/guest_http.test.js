'use strict';
// RJ 493 over HTTP without a database: POST /v1/accounts {guest: true}'s checks in order (the kill switch, accounts-ip,
// admission, guest_per_day_ip) up to the database, and POST /v1/me/upgrade's refusals with a stand-in account store.
// guests.db.test.js drives both against a real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { createAdmission } = require('../src/admission/admission');
const { signSession } = require('../src/auth/tokens');
const { DAY_MS } = require('../src/middleware/rateLimit');

const KEY = 'cd'.repeat(32);
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const HEADERS = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android', 'X-RJ-Install': '6f1c2b8e-0000-4000-8000-000000000001',
};
const OFF = 'Guest play is off right now. Log in or create an account.';
const UPGRADE = { username: 'RealPilot', email: 'real@example.com', password: 'a good password' };

// The upgrade's account store: uid 5 is a guest, 6 has a login, anything else is gone.
function fakeAccounts() {
  const calls = [];
  return {
    calls,
    async userExists(uid) { return uid === 5 || uid === 6; },
    async upgradeGuest(uid, user) {
      calls.push([uid, user]);
      if (user.username === 'Pilot-77') throw new Error('That username is reserved.');
      if (user.username === 'Taken') throw new Error('This username "Taken" is already taken.');
      if (user.username === 'Boom') throw new Error('the database went away');
      if (uid === 6) return 'not_guest';
      if (uid !== 5) return 'gone';
      return { user_id: uid, username: user.username };
    },
  };
}

async function startApp(t, { flags = {}, limits = {}, admission: admissionPatch } = {}) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const view = defaultView('dev');
  Object.assign(view.flags, flags);
  Object.assign(view.server.rate_limits, limits);
  if (admissionPatch) Object.assign(view.server.admission, admissionPatch);
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(view);
  const clock = { t: T0 };
  const now = () => clock.t;
  const env = { ENV: 'dev', SESSION_KEY: KEY };
  const admission = createAdmission({ env, config: () => remote.current(), now });
  const accounts = fakeAccounts();
  const app = createPublicApp(null, { v1: { env, remote, now, admission, accountStore: accounts } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, uid, headers = HEADERS } = {}) => {
    const h = { ...headers };
    if (uid) h.Authorization = `Bearer ${signSession({ uid, env: 'dev', nowSec: Math.floor(clock.t / 1000), keyHex: KEY }).token}`;
    const init = { method, headers: h };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  return { call, view, clock, lines, accounts };
}

const code = (r) => (r.body.result === 'error' ? r.body.error.code : r.body.result);
const guest = { guest: true };

test('guest_play false: VALIDATION with the kill switch\'s message, before any limit is spent', async (t) => {
  const { call, view } = await startApp(t, { flags: { guest_play: false }, limits: { login_per_min_ip: 1, guest_per_day_ip: 1 } });
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/v1/accounts', { body: guest });
    assert.deepEqual([code(r), r.status, r.body.error.message], ['VALIDATION', 400, OFF]);
  }
  view.flags.guest_play = true;
  // No database here: past every check into storage is INTERNAL.
  assert.equal(code(await call('POST', '/v1/accounts', { body: guest })), 'INTERNAL', 'the refusals spent neither limit');
  assert.equal(code(await call('POST', '/v1/accounts', { body: { ...guest, username: 'x', email: 'y', password: 'z' } })), 'RATE_LIMITED',
    'then accounts-ip (1 a minute)');
});

test('only guest: true makes a guest; anything else is an account creation and its rules', async (t) => {
  const { call } = await startApp(t, { flags: { guest_play: false } });
  for (const g of ['true', 1, {}]) {
    const r = await call('POST', '/v1/accounts', { body: { guest: g } });
    assert.equal(code(r), 'INTERNAL', `guest: ${JSON.stringify(g)} goes the account way (no database here)`);
  }
  assert.equal(code(await call('POST', '/v1/accounts', { body: { guest: true, username: 'u'.repeat(65) } })), 'VALIDATION');
});

test('guest_per_day_ip: a fixed 24-hour window per IP, apart from the per-minute limit', async (t) => {
  const { call, clock } = await startApp(t, { limits: { login_per_min_ip: 100, guest_per_day_ip: 2 } });
  assert.equal(code(await call('POST', '/v1/accounts', { body: guest })), 'INTERNAL');
  clock.t += 2 * 60 * 1000;
  assert.equal(code(await call('POST', '/v1/accounts', { body: guest })), 'INTERNAL');
  const r = await call('POST', '/v1/accounts', { body: guest });
  assert.equal(code(r), 'RATE_LIMITED');
  assert.equal(r.body.error.retry.after_ms, DAY_MS - 2 * 60 * 1000, 'until the day window ends');
  assert.equal(code(await call('POST', '/v1/accounts', { body: { username: 'a', email: 'b@c.de', password: 'p' } })), 'INTERNAL',
    'an account creation from the same IP is not a guest');
  clock.t = T0 + DAY_MS;
  assert.equal(code(await call('POST', '/v1/accounts', { body: guest })), 'INTERNAL', 'a new day');
});

test('admission: a guest is queued like an account, and a queued request is not charged to guest_per_day_ip', async (t) => {
  const { call, view } = await startApp(t, { limits: { guest_per_day_ip: 1 }, admission: { enabled: true, rate_per_min: 60, burst: 1 } });
  const other = { ...HEADERS, 'X-RJ-Install': '6f1c2b8e-0000-4000-8000-000000000002' };
  assert.equal(code(await call('POST', '/v1/session', { body: { login: { id: 'p', password: 'x' } }, headers: other })), 'INTERNAL',
    'the one token goes to another install');
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/v1/accounts', { body: guest });
    assert.deepEqual([code(r), r.status, r.body.queued.kind], ['queued', 202, 'admission']);
  }
  view.server.admission.enabled = false;
  assert.equal(code(await call('POST', '/v1/accounts', { body: guest })), 'INTERNAL', 'admitted: the day\'s one guest is still there');
  assert.equal(code(await call('POST', '/v1/accounts', { body: guest })), 'RATE_LIMITED', 'and now it is spent');
});

test('POST /v1/me/upgrade: a session, the live account, then the account limits and maxima, then the store', async (t) => {
  const { call, accounts } = await startApp(t, { limits: { login_per_min_ip: 100 } });
  assert.equal(code(await call('POST', '/v1/me/upgrade', { body: UPGRADE })), 'AUTH_REQUIRED');
  assert.equal(code(await call('POST', '/v1/me/upgrade', { uid: 9, body: UPGRADE })), 'AUTH_INVALID', 'a deleted account');
  const long = await call('POST', '/v1/me/upgrade', { uid: 5, body: { ...UPGRADE, email: `${'e'.repeat(250)}@x.com` } });
  assert.deepEqual([code(long), long.body.error.message], ['VALIDATION', 'That email is too long.']);
  assert.deepEqual(accounts.calls, [], 'nothing reached the store');

  const ok = await call('POST', '/v1/me/upgrade', { uid: 5, body: UPGRADE });
  assert.deepEqual(ok.body, { result: 'ok', data: { user: { id: 5, username: 'RealPilot', guest: false } } });
  assert.deepEqual(accounts.calls, [[5, UPGRADE]]);

  const login = await call('POST', '/v1/me/upgrade', { uid: 6, body: { ...UPGRADE, username: 'Other', email: 'o@x.com' } });
  assert.deepEqual([code(login), login.body.error.message], ['VALIDATION', 'This account already has a login.']);
  for (const [username, message] of [['Pilot-77', 'That username is reserved.'], ['Taken', 'This username "Taken" is already taken.']]) {
    const r = await call('POST', '/v1/me/upgrade', { uid: 5, body: { ...UPGRADE, username, email: `${username}@x.com` } });
    assert.deepEqual([code(r), r.body.error.message], ['VALIDATION', message], username);
  }
  assert.equal(code(await call('POST', '/v1/me/upgrade', { uid: 5, body: { ...UPGRADE, username: 'Boom', email: 'boom@x.com' } })), 'INTERNAL',
    'a fault is not a rule');
});

test('the upgrade shares account creation\'s limits: per IP, and per username and email', async (t) => {
  const { call } = await startApp(t, { limits: { login_per_min_ip: 100, login_per_min_account: 2 } });
  for (let i = 0; i < 2; i++) assert.equal(code(await call('POST', '/v1/accounts', { body: UPGRADE })), 'INTERNAL');
  const r = await call('POST', '/v1/me/upgrade', { uid: 5, body: UPGRADE });
  assert.equal(code(r), 'RATE_LIMITED', 'the username and email were tried twice already at /v1/accounts');
  assert.equal(code(await call('POST', '/v1/me/upgrade', { uid: 5, body: { ...UPGRADE, username: 'Fresh', email: 'fresh@x.com' } })), 'ok');
});
