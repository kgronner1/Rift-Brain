'use strict';
// RJ 473 over HTTP without a database: DELETE /v1/me's checks in order (session, RATE_LIMITED, the account, then for
// an account with a login VALIDATION and the password; RJ 493: a guest needs none), its ok, the match registry release
// and the log line; and the /me writes refusing a session whose account is gone. The account store and the registry
// are stand-ins; account_delete.db.test.js drives the real ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { signSession } = require('../src/auth/tokens');

const KEY = 'cd'.repeat(32);
const NOW_MS = Date.UTC(2026, 9, 14, 12, 0, 0);
const NOW_SEC = NOW_MS / 1000;
const PASSWORD = 'the right one';

const GOOD = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android', 'X-RJ-Install': '6f1c2b8e-0000-4000-8000-000000000001',
};

// users: uid -> password (null: a guest, RJ 493). Deleting removes the entry.
function fakeAccounts(users = { 7: PASSWORD, 8: PASSWORD, 10: null }) {
  const calls = [];
  const live = new Map(Object.entries(users).map(([k, v]) => [Number(k), v]));
  return {
    calls,
    live,
    async userExists(uid) { calls.push(['exists', uid]); return live.has(uid); },
    async findAccount(uid) {
      calls.push(['find', uid]);
      return live.has(uid) ? { user_id: uid, username: `u${uid}`, guest: live.get(uid) === null } : null;
    },
    async verifyUserPassword(uid, password) {
      calls.push(['verify', uid]);
      if (!live.has(uid)) return 'gone';
      return live.get(uid) === password ? 'ok' : 'wrong';
    },
    async deleteUser(uid) { calls.push(['delete', uid]); return live.delete(uid); },
  };
}

function fakeMatch() {
  const released = [];
  return { released, async releasePlayer(uid) { released.push(uid); } };
}

function view(patch = {}) {
  const v = defaultView('dev');
  Object.assign(v.gates, patch);
  return v;
}

async function startApp(t, { v = view(), accounts = fakeAccounts(), match = fakeMatch() } = {}) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(v);
  const env = { ENV: 'dev', SESSION_KEY: KEY };
  const app = createPublicApp(null, { v1: { env, remote, now: () => NOW_MS, match, accountStore: accounts } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { uid = 7, token, headers = GOOD, body } = {}) => {
    const h = { ...headers };
    const bearer = token !== undefined ? token : (uid ? signSession({ uid, env: 'dev', nowSec: NOW_SEC, keyHex: KEY }).token : null);
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    const init = { method, headers: h };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    return { status: r.status, headers: r.headers, body: JSON.parse(await r.text()) };
  };
  return { call, lines, accounts, match, v };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

test('DELETE /v1/me needs a session; an account with a login then needs its password (VALIDATION) before it is checked', async (t) => {
  const v = view();
  v.server.rate_limits = { ...v.server.rate_limits, login_per_min_account: 100 };
  const { call, accounts } = await startApp(t, { v });
  assert.equal(code(await call('DELETE', '/v1/me', { uid: 0, body: { password: PASSWORD } })), 'AUTH_REQUIRED');
  const old = signSession({ uid: 7, env: 'dev', nowSec: NOW_SEC - 3600, keyHex: KEY }).token;
  assert.equal(code(await call('DELETE', '/v1/me', { token: old, body: { password: PASSWORD } })), 'AUTH_EXPIRED');
  for (const body of [undefined, {}, { password: '' }, { password: 5 }, { password: null }, { password: 'p'.repeat(1025) }, []]) {
    const r = await call('DELETE', '/v1/me', { body });
    assert.deepEqual([code(r), r.status, r.body.error.message], ['VALIDATION', 400, 'Enter your password.'], JSON.stringify(body));
  }
  assert.ok(accounts.calls.every(([op]) => op === 'find'), 'the password was never checked, nothing deleted');
  assert.equal(code(await call('DELETE', '/v1/me', { body: { password: 'p'.repeat(1024) } })), 'AUTH_INVALID', '1024 is allowed');
});

test('a wrong password is AUTH_INVALID with its own message and deletes nothing; a gone account is plain AUTH_INVALID', async (t) => {
  const { call, accounts, match } = await startApp(t);
  const wrong = await call('DELETE', '/v1/me', { body: { password: 'not it' } });
  assert.equal(code(wrong), 'AUTH_INVALID');
  assert.deepEqual([wrong.status, wrong.body.error.message, wrong.body.error.scope], [401, "That password isn't right.", 'account']);
  assert.deepEqual(accounts.calls, [['find', 7], ['verify', 7]]);
  assert.equal(accounts.live.has(7), true);
  assert.deepEqual(match.released, []);

  const gone = await call('DELETE', '/v1/me', { uid: 9, body: { password: PASSWORD } });
  assert.equal(code(gone), 'AUTH_INVALID');
  assert.equal(gone.body.error.message, "That username, email or password isn't right.", 'the code\'s default message');
  assert.equal(accounts.calls.some(([op]) => op === 'delete'), false);
});

test('ok: {} once the account is deleted and its match seats released; one log line, never the password', async (t) => {
  const { call, accounts, match, lines } = await startApp(t);
  const r = await call('DELETE', '/v1/me', { body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'ok', data: {} });
  assert.deepEqual(accounts.calls, [['find', 7], ['verify', 7], ['delete', 7]]);
  assert.deepEqual(match.released, [7]);
  assert.deepEqual(lines.filter((l) => l.startsWith('[account]')), ['[account] user 7 deleted']);
  assert.ok(lines.some((l) => /^\[v1\] r-[0-9a-f]+ DELETE \/v1\/me 200/.test(l)), 'the request line was captured (the measurement works)');
  assert.ok(!lines.join('\n').includes(PASSWORD));

  const again = await call('DELETE', '/v1/me', { body: { password: PASSWORD } });
  assert.equal(code(again), 'AUTH_INVALID', 'a second delete with the same session finds the account gone');
  assert.equal(accounts.live.has(8), true, 'only the session\'s own account');
});

test('a delete that loses the race to another answers ok without a second log line', async (t) => {
  const accounts = fakeAccounts();
  accounts.deleteUser = async (uid) => { accounts.calls.push(['delete', uid]); return false; };
  const { call, lines, match } = await startApp(t, { accounts });
  assert.deepEqual((await call('DELETE', '/v1/me', { body: { password: PASSWORD } })).body, { result: 'ok', data: {} });
  assert.deepEqual(lines.filter((l) => l.startsWith('[account]')), []);
  assert.deepEqual(match.released, [7]);
});

test('rate limited per account from login_per_min_account, in a bucket apart from password logins', async (t) => {
  const v = view();
  v.server.rate_limits = { ...v.server.rate_limits, login_per_min_account: 2 };
  const { call, accounts } = await startApp(t, { v });
  for (let i = 0; i < 2; i++) {
    // Logins for the same name as the uid: another bucket, so they spend none of the delete's attempts.
    await call('POST', '/v1/session', { uid: 0, body: { login: { id: '7', password: 'x' } } });
  }
  assert.equal(code(await call('DELETE', '/v1/me', { body: { password: 'wrong 1' } })), 'AUTH_INVALID');
  assert.equal(code(await call('DELETE', '/v1/me', { body: { password: 'wrong 2' } })), 'AUTH_INVALID');
  const r = await call('DELETE', '/v1/me', { body: { password: PASSWORD } });
  assert.equal(code(r), 'RATE_LIMITED');
  assert.equal(r.status, 429);
  assert.ok(r.body.error.retry.after_ms > 0 && r.body.error.retry.after_ms <= 60000);
  assert.equal(accounts.live.has(7), true, 'the limit holds even for the right password');
  assert.equal(code(await call('DELETE', '/v1/me', { uid: 8, body: { password: PASSWORD } })), 'ok', 'another account has its own count');
});

test('not a multiplayer route: the multiplayer floor and multiplayer maintenance never block it; app maintenance does', async (t) => {
  const mp = await startApp(t, { v: view({
    min_build_multiplayer: { default: 99999999 },
    maintenance: { active: true, scope: 'multiplayer', title: '', message: '', ends_at: null },
  }) });
  assert.equal(code(await mp.call('DELETE', '/v1/me', { body: { password: PASSWORD } })), 'ok');
  const app = await startApp(t, { v: view({ maintenance: { active: true, scope: 'app', title: '', message: '', ends_at: null } }) });
  assert.equal(code(await app.call('DELETE', '/v1/me', { body: { password: PASSWORD } })), 'MAINTENANCE');
  assert.deepEqual(app.accounts.calls, []);
});

test('the /me writes answer AUTH_INVALID for a session whose account is gone, before anything is written', async (t) => {
  const { call, accounts } = await startApp(t);
  const writes = [
    ['POST', '/v1/me/sp-stats/sync', { stats: { _last_updated: NOW_SEC, sp_most_jumps_in_a_run: 5 } }],
    ['POST', '/v1/me/accolades/sync', { accolades: { _last_updated: NOW_SEC, Ghost: 1 } }],
    ['PUT', '/v1/me/player-card', { equipped_accolade_key: 'Ghost' }],
  ];
  for (const [method, path, body] of writes) {
    const r = await call(method, path, { uid: 9, body });
    assert.deepEqual([code(r), r.status, r.body.error.scope], ['AUTH_INVALID', 401, 'account'], path);
  }
  // With the account there, the same calls get past the check into storage (INTERNAL: no database here).
  for (const [method, path, body] of writes) assert.equal(code(await call(method, path, { body })), 'INTERNAL', path);
  assert.deepEqual(accounts.calls.map(([op, uid]) => `${op} ${uid}`), ['exists 9', 'exists 9', 'exists 9', 'exists 7', 'exists 7', 'exists 7']);
});

test('RJ 493: a guest deletes with no password; one sent is ignored, never checked', async (t) => {
  for (const body of [undefined, {}, { password: 'anything' }, { password: 5 }]) {
    const { call, accounts, match, lines } = await startApp(t);
    const r = await call('DELETE', '/v1/me', { uid: 10, body });
    assert.deepEqual(r.body, { result: 'ok', data: {} }, JSON.stringify(body));
    assert.deepEqual(accounts.calls, [['find', 10], ['delete', 10]]);
    assert.deepEqual(match.released, [10]);
    assert.deepEqual(lines.filter((l) => l.startsWith('[account]')), ['[account] user 10 deleted']);
  }
  const { call } = await startApp(t);
  assert.equal(code(await call('DELETE', '/v1/me', { body: {} })), 'VALIDATION', 'an account with a login still needs it');
});
