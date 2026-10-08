'use strict';
// /v1 over HTTP without a database: the header middleware's order (spec 4.9), the middleware stack's order (ids,
// headers, body, auth), the envelope on the wire, and auth's codes. Routes that would reach the database are only
// driven as far as the checks in front of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createLobbyRegistry } = require('../src/match/lobbies');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { signSession, sign } = require('../src/auth/tokens');
const { checkClient } = require('../src/middleware/clientHeaders');

const KEY = 'cd'.repeat(32);
const OTHER_KEY = 'ef'.repeat(32);
const NOW_MS = Date.UTC(2026, 9, 8, 12, 0, 0);
const NOW_SEC = NOW_MS / 1000;

const GOOD = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android', 'X-RJ-Install': '6f1c2b8e-0000-4000-8000-000000000001',
};

function view(patch = {}) {
  const v = defaultView('dev');
  Object.assign(v.gates, patch);
  return v;
}

async function startApp(t, { v = view(), now = () => NOW_MS } = {}) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(v);
  const env = { ENV: 'dev', SESSION_KEY: KEY };
  const lobbies = createLobbyRegistry({ ports: [8100], serverBinary: '/bin/game', runCommand: async () => 1 });
  const app = createPublicApp(lobbies, { v1: { env, remote, now } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    lobbies.stop();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { headers = GOOD, body, raw } = {}) => {
    const init = { method, headers: { ...headers } };
    if (raw !== undefined) {
      init.body = raw;
      init.headers['Content-Type'] = 'application/json';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: JSON.parse(text) };
  };
  return { call, lines, remote };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

// --- the five checks, in order (pure) ------------------------------------------------------------------------------

test('clientHeaders checks env, then api, then min_build, then min_build_multiplayer, then maintenance', () => {
  const allFail = view({
    min_build: { default: 100 }, min_build_multiplayer: { default: 200 },
    maintenance: { active: true, scope: 'app', title: '', message: 'Down.', ends_at: null },
  });
  const client = { env: 'alpha', api: 2, build: 50, platform: 'android' };
  const at = (c, v, multiplayer = true) => {
    const r = checkClient(c, { serverEnv: 'dev', view: v, multiplayer, nowMs: NOW_MS });
    return r && [r[0], r[1].scope];
  };
  assert.deepEqual(at(client, allFail), ['ENV_MISMATCH', undefined]);
  assert.deepEqual(at({ ...client, env: 'dev' }, allFail), ['API_UNSUPPORTED', undefined]);
  assert.deepEqual(at({ ...client, env: 'dev', api: 1 }, allFail), ['UPDATE_REQUIRED', 'app']);
  assert.deepEqual(at({ ...client, env: 'dev', api: 1, build: 150 }, allFail), ['UPDATE_REQUIRED', 'multiplayer']);
  assert.deepEqual(at({ ...client, env: 'dev', api: 1, build: 250 }, allFail), ['MAINTENANCE', 'app']);
  assert.equal(at({ ...client, env: 'dev', api: 1, build: 250 }, view()), null);
});

test('min_build_multiplayer and multiplayer maintenance only bind multiplayer routes; app maintenance binds all', () => {
  const ok = { env: 'dev', api: 1, build: 10, platform: 'ios' };
  const check = (v, multiplayer) => checkClient(ok, { serverEnv: 'dev', view: v, multiplayer, nowMs: NOW_MS });
  const mpFloor = view({ min_build_multiplayer: { default: 0, ios: 11 } });
  assert.equal(check(mpFloor, false), null);
  assert.equal(check(mpFloor, true)[0], 'UPDATE_REQUIRED');
  const mpMaint = view({ maintenance: { active: true, scope: 'multiplayer', title: 'T', message: 'M', ends_at: null } });
  assert.equal(check(mpMaint, false), null);
  assert.equal(check(mpMaint, true)[0], 'MAINTENANCE');
  const appMaint = view({ maintenance: { active: true, scope: 'app', title: '', message: '', ends_at: null } });
  assert.equal(check(appMaint, false)[0], 'MAINTENANCE');
});

test('platform floors take <platform> first, then default; an unknown platform reads default', () => {
  const v = view({ min_build: { default: 5, android: 20 } });
  const at = (platform, build) => checkClient({ env: 'dev', api: 1, build, platform }, { serverEnv: 'dev', view: v, multiplayer: false, nowMs: NOW_MS });
  assert.equal(at('android', 19)[0], 'UPDATE_REQUIRED');
  assert.equal(at('android', 20), null);
  assert.equal(at('ios', 5), null);
  assert.equal(at('ios', 4)[0], 'UPDATE_REQUIRED');
  assert.equal(at('macos', 4)[0], 'UPDATE_REQUIRED');
});

test('maintenance waits until ends_at (with the client\'s jitter on top), or backs off when there is no end', () => {
  const ends = new Date(NOW_MS + 90 * 1000).toISOString();
  const r = checkClient({ env: 'dev', api: 1, build: 1, platform: 'android' }, {
    serverEnv: 'dev', multiplayer: true, nowMs: NOW_MS,
    view: view({ maintenance: { active: true, scope: 'multiplayer', title: 'Patch', message: 'Back soon.', ends_at: ends } }),
  });
  assert.deepEqual(r, ['MAINTENANCE', { scope: 'multiplayer', retry: { kind: 'after', after_ms: 90000 }, message: 'Back soon.', title: 'Patch' }]);
  const open = checkClient({ env: 'dev', api: 1, build: 1, platform: 'android' }, {
    serverEnv: 'dev', multiplayer: true, nowMs: NOW_MS,
    view: view({ maintenance: { active: true, scope: 'multiplayer', title: '', message: '', ends_at: null } }),
  });
  assert.deepEqual(open[1].retry, { kind: 'backoff' });
});

// --- over HTTP ------------------------------------------------------------------------------------------------------

test('every /v1 response is a JSON envelope whose ref is also its X-RJ-Ref header', async (t) => {
  const { call } = await startApp(t);
  const r = await call('GET', '/v1/stats/columns', { headers: {} });
  assert.equal(r.status, 421);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(code(r), 'ENV_MISMATCH');
  assert.match(r.body.error.ref, /^r-[0-9a-f]{12}$/);
  assert.equal(r.headers.get('x-rj-ref'), r.body.error.ref);
  assert.deepEqual(r.body.error.retry, { kind: 'never' });
  assert.equal(r.body.error.scope, 'app');
});

test('the gates run before auth and before the body is read', async (t) => {
  const { call } = await startApp(t);
  const wrongEnv = { ...GOOD, 'X-RJ-Env': 'alpha' };
  assert.equal(code(await call('POST', '/v1/me/sp-stats/sync', { headers: wrongEnv, body: {} })), 'ENV_MISMATCH');
  assert.equal(code(await call('POST', '/v1/session', { headers: wrongEnv, raw: '{not json' })), 'ENV_MISMATCH');
  assert.equal(code(await call('POST', '/v1/session', { headers: { ...GOOD, 'X-RJ-Api': '2' }, raw: '{not json' })), 'API_UNSUPPORTED');
  const bad = await call('POST', '/v1/session', { raw: '{not json' });
  assert.equal(code(bad), 'VALIDATION');
  assert.equal(bad.status, 400);
});

test('a multiplayer route gets the multiplayer gates before it is even routed (spec 4.9, gate 4)', async (t) => {
  const { call } = await startApp(t, { v: view({ min_build_multiplayer: { default: 99999999 } }) });
  const r = await call('POST', '/v1/match/join', { body: { mode: 'quickplay' } });
  assert.equal(code(r), 'UPDATE_REQUIRED');
  assert.equal(r.body.error.scope, 'multiplayer');
  assert.equal(r.status, 426);
  assert.equal(code(await call('GET', '/v1/stats/columns', { headers: { ...GOOD, Authorization: 'x' } })) !== 'UPDATE_REQUIRED', true);
});

test('app maintenance answers every route, with config\'s text and Retry-After', async (t) => {
  const ends = new Date(NOW_MS + 120 * 1000).toISOString();
  const { call } = await startApp(t, { v: view({ maintenance: { active: true, scope: 'app', title: 'Patch day', message: 'Back at noon.', ends_at: ends } }) });
  const r = await call('POST', '/v1/session', { body: {} });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '120');
  assert.deepEqual({ ...r.body.error, ref: '' }, {
    code: 'MAINTENANCE', message: 'Back at noon.', title: 'Patch day', retry: { kind: 'after', after_ms: 120000 },
    scope: 'app', action: { kind: 'dismiss' }, ref: '',
  });
});

test('an unknown /v1 route is a VALIDATION 404 envelope, not Express\'s HTML', async (t) => {
  const { call } = await startApp(t);
  const r = await call('GET', '/v1/nope');
  assert.equal(r.status, 404);
  assert.equal(code(r), 'VALIDATION');
  assert.equal(code(await call('DELETE', '/v1/session')), 'VALIDATION');
});

test('locked routes: no token, a bad one, a forged one or another type -> AUTH_REQUIRED; an expired one -> AUTH_EXPIRED', async (t) => {
  const { call } = await startApp(t);
  const at = async (authorization) => code(await call('POST', '/v1/me/sp-stats/sync', {
    headers: authorization === undefined ? GOOD : { ...GOOD, Authorization: authorization }, body: { stats: {} },
  }));
  assert.equal(await at(undefined), 'AUTH_REQUIRED');
  assert.equal(await at('Bearer'), 'AUTH_REQUIRED');
  assert.equal(await at('Bearer abc.def'), 'AUTH_REQUIRED');
  const wrongKey = signSession({ uid: 7, env: 'dev', nowSec: NOW_SEC, keyHex: OTHER_KEY }).token;
  assert.equal(await at(`Bearer ${wrongKey}`), 'AUTH_REQUIRED');
  const otherEnv = signSession({ uid: 7, env: 'alpha', nowSec: NOW_SEC, keyHex: KEY }).token;
  assert.equal(await at(`Bearer ${otherEnv}`), 'AUTH_REQUIRED');
  const grant = sign({ v: 1, typ: 'g', ticket: 'q_1', install: 'i', env: 'dev', iat: NOW_SEC, exp: NOW_SEC + 100 }, KEY);
  assert.equal(await at(`Bearer ${grant}`), 'AUTH_REQUIRED', 'an admission grant is not a session');
  const expired = signSession({ uid: 7, env: 'dev', nowSec: NOW_SEC - 3600, keyHex: KEY }).token;
  const r = await call('POST', '/v1/me/sp-stats/sync', { headers: { ...GOOD, Authorization: `Bearer ${expired}` }, body: {} });
  assert.equal(code(r), 'AUTH_EXPIRED');
  assert.equal(r.status, 401);
  assert.deepEqual([r.body.error.scope, r.body.error.action.kind], ['account', 'login']);
});

test('a valid session gets past auth (and, with no database here, into INTERNAL, logged with its ref)', async (t) => {
  const { call, lines } = await startApp(t);
  const token = signSession({ uid: 7, env: 'dev', nowSec: NOW_SEC, keyHex: KEY }).token;
  const r = await call('POST', '/v1/me/sp-stats/sync', { headers: { ...GOOD, Authorization: `Bearer ${token}` }, body: {} });
  assert.equal(code(r), 'INTERNAL');
  assert.deepEqual(r.body.error.retry, { kind: 'backoff' });
  assert.ok(lines.some((l) => l.includes(r.body.error.ref) && l.includes('INTERNAL')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes(token)), 'the session token is never logged');
});

test('input checks answer VALIDATION before any database work', async (t) => {
  const { call } = await startApp(t);
  assert.equal(code(await call('POST', '/v1/session', { body: {} })), 'VALIDATION');
  assert.equal(code(await call('POST', '/v1/session', { body: { login: { id: 'a', password: 5 } } })), 'VALIDATION');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: { user_id: 'x', token: 't' } } })), 'VALIDATION');
  assert.equal(code(await call('GET', '/v1/users/abc/stats')), 'VALIDATION');
  assert.equal(code(await call('GET', '/v1/users/00/accolades')), 'VALIDATION');
  assert.equal(code(await call('POST', '/v1/accounts', { body: { username: 'u'.repeat(65), email: 'a@b.co', password: 'p' } })), 'VALIDATION');
});

test('password logins are rate limited per account (and per IP), from config, before bcrypt', async (t) => {
  const v = view();
  v.server.rate_limits = { login_per_min_ip: 100, login_per_min_account: 2, restore_per_min_credential: 30 };
  const { call } = await startApp(t, { v });
  const attempt = () => call('POST', '/v1/session', { body: { login: { id: 'Pilot', password: 'pw' } } });
  // No database: the first two get past the limiter into INTERNAL; the third is refused in front of it.
  assert.equal(code(await attempt()), 'INTERNAL');
  assert.equal(code(await call('POST', '/v1/session', { body: { login: { id: 'pilot', password: 'pw' } } })), 'INTERNAL');
  const r = await attempt();
  assert.equal(code(r), 'RATE_LIMITED');
  assert.equal(r.status, 429);
  assert.equal(r.body.error.retry.kind, 'after');
  assert.ok(r.body.error.retry.after_ms > 0 && r.body.error.retry.after_ms <= 60000);
  assert.equal(r.headers.get('retry-after'), String(Math.ceil(r.body.error.retry.after_ms / 1000)));
  assert.equal(code(await call('POST', '/v1/session', { body: { login: { id: 'other', password: 'pw' } } })), 'INTERNAL');
});

test('the legacy routes are unchanged beside /v1', async (t) => {
  const { call } = await startApp(t);
  const r = await call('POST', '/user_all_stats', { headers: {}, body: { user_id: 'x' } });
  assert.deepEqual([r.status, r.body], [400, { success: false, message: 'Invalid user_id' }]);
});
