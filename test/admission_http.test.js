'use strict';
// Admission (M6) over HTTP without a database: login, credential restore and account creation answer `queued` in
// front of the database; /v1/queue/:ticket hands out the grant; an expired, unknown or foreign ticket is
// QUEUE_TICKET_INVALID; switching admission off in config releases the line. Redeeming a grant all the way to a
// session needs the database: admission.db.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { createAdmission } = require('../src/admission/admission');
const { signSession, verifyGrant, nowSecFrom } = require('../src/auth/tokens');

const KEY = 'cd'.repeat(32);
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const HEADERS = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android',
};
const as = (n) => ({ ...HEADERS, 'X-RJ-Install': `6f1c2b8e-0000-4000-8000-${String(n).padStart(12, '0')}` });

async function startApp(t, admissionPatch) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const view = defaultView('dev');
  Object.assign(view.server.admission, admissionPatch);
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(view);
  const clock = { t: T0 };
  const now = () => clock.t;
  const env = { ENV: 'dev', SESSION_KEY: KEY };
  const admission = createAdmission({ env, config: () => remote.current(), now });
  const app = createPublicApp(null, { v1: { env, remote, now, admission } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { headers = as(1), body } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  const run = (sec) => {
    for (let i = 0; i < sec; i++) {
      clock.t += 1000;
      admission.sweep();
    }
  };
  return { call, view, run, clock, lines, admission };
}

const code = (r) => (r.body.result === 'error' ? r.body.error.code : r.body.result);
// One account per install: login_per_min_account (5) would otherwise answer RATE_LIMITED.
const login = (n) => ({ login: { id: `pilot${n}`, password: 'pw' } });
const ACCOUNT = { username: 'newpilot', email: 'new@example.com', password: 'pw-pw-pw-pw' };

test('admission on with an empty bucket: login, restore and account creation answer queued (202), before the database', async (t) => {
  const { call } = await startApp(t, { enabled: true, rate_per_min: 60, burst: 1 });
  // The one token goes to the first request, which then reaches the database (none here: INTERNAL).
  assert.equal(code(await call('POST', '/v1/session', { body: login(1), headers: as(1) })), 'INTERNAL');

  const queuedLogin = await call('POST', '/v1/session', { body: login(2), headers: as(2) });
  assert.equal(queuedLogin.status, 202);
  assert.equal(queuedLogin.body.result, 'queued');
  const q = queuedLogin.body.queued;
  assert.deepEqual(Object.keys(q), ['ticket', 'kind', 'position', 'eta_sec', 'poll_after_ms', 'expires_in_sec', 'message']);
  assert.equal(q.kind, 'admission');
  assert.equal(q.position, 1);
  assert.equal(q.expires_in_sec, 600);
  assert.equal(q.message, "Lots of pilots are launching right now. You're in line.");

  const restore = await call('POST', '/v1/session', {
    body: { credential: { user_id: 7, token: 'A'.repeat(43) } }, headers: as(3),
  });
  assert.equal(code(restore), 'queued');
  assert.equal(restore.body.queued.position, 2);

  const acct = await call('POST', '/v1/accounts', { body: ACCOUNT, headers: as(4) });
  assert.equal(acct.status, 202);
  assert.equal(acct.body.queued.kind, 'admission');
  assert.equal(acct.body.queued.position, 3);
});

test('input checks and rate limits still come first: bad input is VALIDATION, not a place in line', async (t) => {
  const { call } = await startApp(t, { enabled: true, burst: 1 });
  await call('POST', '/v1/session', { body: login(1), headers: as(1) });
  assert.equal(code(await call('POST', '/v1/session', { body: { login: { id: '', password: 'x' } }, headers: as(2) })), 'VALIDATION');
  assert.equal(code(await call('POST', '/v1/accounts', { body: { ...ACCOUNT, username: 'x'.repeat(65) }, headers: as(2) })), 'VALIDATION');
});

test('polling hands out a grant bound to the install; a foreign, unknown or expired ticket is QUEUE_TICKET_INVALID', async (t) => {
  const { call, run, clock } = await startApp(t, { enabled: true, rate_per_min: 60, burst: 1, ticket_ttl_sec: 60 });
  await call('POST', '/v1/session', { body: login(1), headers: as(1) });
  const ticket = (await call('POST', '/v1/session', { body: login(2), headers: as(2) })).body.queued.ticket;

  const waiting = await call('GET', `/v1/queue/${ticket}`, { headers: as(2) });
  assert.equal(code(waiting), 'queued');
  assert.equal(waiting.body.queued.ticket, ticket);

  run(2);
  const granted = await call('GET', `/v1/queue/${ticket}`, { headers: as(2) });
  assert.equal(granted.status, 200);
  assert.deepEqual(Object.keys(granted.body.data), ['grant']);
  const g = verifyGrant(granted.body.data.grant, { keyHex: KEY, env: 'dev', nowSec: nowSecFrom(clock.t) });
  assert.equal(g.ok, true);
  assert.equal(g.payload.install, as(2)['X-RJ-Install']);

  const foreign = await call('GET', `/v1/queue/${ticket}`, { headers: as(3) });
  assert.equal(code(foreign), 'QUEUE_TICKET_INVALID');
  assert.equal(foreign.status, 404);
  assert.equal(code(await call('DELETE', `/v1/queue/${ticket}`, { headers: as(3) })), 'QUEUE_TICKET_INVALID');
  assert.equal(code(await call('GET', '/v1/queue/q_neverissuedatall', { headers: as(2) })), 'QUEUE_TICKET_INVALID');
  assert.equal(code(await call('GET', '/v1/queue/not-a-ticket', { headers: as(2) })), 'QUEUE_TICKET_INVALID');

  // A grant redeemed by another install is refused at /v1/session.
  const wrong = await call('POST', '/v1/session', { body: { ...login(3), grant: granted.body.data.grant }, headers: as(3) });
  assert.equal(code(wrong), 'QUEUE_TICKET_INVALID');
  // Its own install gets past admission (and, with no database here, into INTERNAL).
  const own = await call('POST', '/v1/session', { body: { ...login(2), grant: granted.body.data.grant }, headers: as(2) });
  assert.equal(code(own), 'INTERNAL');

  // A ticket nobody polls for ticket_ttl_sec is gone.
  await call('POST', '/v1/session', { body: login(5), headers: as(5) }); // takes the token that refilled
  const t3 = (await call('POST', '/v1/session', { body: login(6), headers: as(6) })).body.queued.ticket;
  run(30);
  assert.equal(code(await call('GET', `/v1/queue/${t3}`, { headers: as(6) })), 'ok', 'alive (and granted) at 30 s');
  run(61);
  assert.equal(code(await call('GET', `/v1/queue/${t3}`, { headers: as(6) })), 'QUEUE_TICKET_INVALID');
});

test('DELETE leaves the line', async (t) => {
  const { call } = await startApp(t, { enabled: true, burst: 1, rate_per_min: 1 });
  await call('POST', '/v1/session', { body: login(1), headers: as(1) });
  const ticket = (await call('POST', '/v1/session', { body: login(2), headers: as(2) })).body.queued.ticket;
  const del = await call('DELETE', `/v1/queue/${ticket}`, { headers: as(2) });
  assert.deepEqual(del.body, { result: 'ok', data: {} });
  assert.equal(code(await call('GET', `/v1/queue/${ticket}`, { headers: as(2) })), 'QUEUE_TICKET_INVALID');
});

test('a refresh within session_refresh_grace_sec skips the line; an older session or no session does not', async (t) => {
  const { call, clock } = await startApp(t, { enabled: true, burst: 1, rate_per_min: 1, session_refresh_grace_sec: 86400 });
  await call('POST', '/v1/session', { body: login(1), headers: as(1) });
  const credential = { user_id: 7, token: 'A'.repeat(43) };
  const recent = signSession({ uid: 7, env: 'dev', nowSec: nowSecFrom(clock.t) - 3 * 3600, keyHex: KEY }).token;
  const old = signSession({ uid: 7, env: 'dev', nowSec: nowSecFrom(clock.t) - 86401, keyHex: KEY }).token;
  const otherUser = signSession({ uid: 8, env: 'dev', nowSec: nowSecFrom(clock.t) - 60, keyHex: KEY }).token;

  // Past admission means into the database: INTERNAL here (admission.db.test.js goes all the way).
  assert.equal(code(await call('POST', '/v1/session', { body: { credential, session: recent }, headers: as(2) })), 'INTERNAL');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential, session: old }, headers: as(3) })), 'queued');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential, session: otherUser }, headers: as(4) })), 'queued');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential }, headers: as(5) })), 'queued');
});

test('turning admission off in config releases everyone: polls grant and sign-ins pass, with no restart', async (t) => {
  const { call, view, lines } = await startApp(t, { enabled: true, burst: 1, rate_per_min: 1 });
  await call('POST', '/v1/session', { body: login(1), headers: as(1) });
  const tickets = [];
  for (let i = 2; i <= 6; i++) tickets.push((await call('POST', '/v1/session', { body: login(i), headers: as(i) })).body.queued.ticket);
  view.server.admission.enabled = false;
  for (let i = 0; i < tickets.length; i++) {
    const r = await call('GET', `/v1/queue/${tickets[i]}`, { headers: as(i + 2) });
    assert.equal(code(r), 'ok');
    assert.equal(typeof r.body.data.grant, 'string');
  }
  assert.equal(code(await call('POST', '/v1/accounts', { body: ACCOUNT, headers: as(50) })), 'INTERNAL');
  assert.ok(lines.every((l) => !/eyJ/.test(l)), 'no token in any log line');
});

test('the lobby-wait queue still answers on the same endpoint (unknown to admission, known to the registry)', async (t) => {
  // match_http.test.js drives every lobby outcome; here only that a router without a registry still has /v1/queue.
  const { call } = await startApp(t, { enabled: false });
  assert.equal(code(await call('GET', '/v1/queue/q_abcdefghijkl', { headers: as(1) })), 'QUEUE_TICKET_INVALID');
});
