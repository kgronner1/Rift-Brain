'use strict';
// Admission (M6) end to end against a real database built from migrations/: a queued password login, account
// creation and credential restore are granted, and the grant is redeemed at /v1/session and /v1/accounts for a
// session; a refresh skips the line; a grant is bound to its install; switching admission off releases the line.
// Runs only with RJ_TEST_DB set (see migrate.db.test.js); this file uses its own database, <name>_adm.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { createAdmission } = require('../src/admission/admission');
const { verifySession, nowSecFrom } = require('../src/auth/tokens');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const KEY = '6b'.repeat(32);
const HEADERS = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android',
};
const as = (n) => ({ ...HEADERS, 'X-RJ-Install': `install-adm-${n}` });
const PASSWORD = 'correct horse battery';

const ctx = {};

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_adm`;
  const cfg = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...cfg, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\``);
  const conn = await mysql.createConnection({ ...cfg, database: name, multipleStatements: true });
  await migrate(conn, { log: () => {} });
  await conn.end();
  ctx.admin = admin;
  ctx.db = name;
  initDB({ ...cfg, database: name });

  ctx.view = defaultView('dev');
  const remote = createRemoteConfig({ env: 'dev', url: null, log: { info() {}, warn() {}, error() {} } });
  remote._set(ctx.view);
  ctx.lines = [];
  ctx.restore = [];
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    console[m] = (...a) => ctx.lines.push(a.join(' '));
    ctx.restore.push(() => { console[m] = orig; });
  }
  ctx.offset = 0;
  ctx.now = () => Date.now() + ctx.offset;
  const env = { ENV: 'dev', SESSION_KEY: KEY };
  ctx.admission = createAdmission({ env, config: () => remote.current(), now: ctx.now });
  const app = createPublicApp(null, { v1: { env, remote, now: ctx.now, admission: ctx.admission } });
  ctx.server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.server.close();
  await getDB().end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.db}\``);
  await ctx.admin.end();
});

async function call(method, path, { body, headers = as(1) } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(ctx.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: JSON.parse(await r.text()) };
}

const code = (r) => (r.body.result === 'error' ? r.body.error.code : r.body.result);

function admissionOn(patch = {}) {
  Object.assign(ctx.view.server.admission, { enabled: true, rate_per_min: 60, burst: 1 }, patch);
}

function run(sec) {
  for (let i = 0; i < sec; i++) {
    ctx.offset += 1000;
    ctx.admission.sweep();
  }
}

// Spends the bucket so the next sign-in queues: a sign-in that is admitted and reaches the database.
async function drainBucket(n) {
  return call('POST', '/v1/session', { headers: as(n), body: { login: { id: 'nobody', password: 'x' } } });
}

function login(id) {
  return { login: { id, password: PASSWORD } };
}

test('with admission off, accounts are made as before', { skip }, async () => {
  for (const n of [1, 2, 3]) {
    const r = await call('POST', '/v1/accounts', { headers: as(n), body: { username: `Adm_${n}`, email: `adm${n}@example.com`, password: PASSWORD } });
    assert.equal(code(r), 'ok');
    ctx[`u${n}`] = r.body.data;
  }
});

test('a queued password login is granted by polling, and the grant is redeemed at /v1/session for a session', { skip }, async () => {
  admissionOn();
  assert.equal(code(await drainBucket(90)), 'AUTH_INVALID');
  const queued = await call('POST', '/v1/session', { headers: as(1), body: login('Adm_1') });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.queued.kind, 'admission');
  const ticket = queued.body.queued.ticket;
  assert.equal(code(await call('GET', `/v1/queue/${ticket}`, { headers: as(1) })), 'queued');

  run(2);
  const polled = await call('GET', `/v1/queue/${ticket}`, { headers: as(1) });
  assert.equal(code(polled), 'ok');
  const { grant } = polled.body.data;

  // Bound to the install: another install cannot redeem it.
  assert.equal(code(await call('POST', '/v1/session', { headers: as(2), body: { ...login('Adm_2'), grant } })), 'QUEUE_TICKET_INVALID');

  const r = await call('POST', '/v1/session', { headers: as(1), body: { ...login('Adm_1'), grant } });
  assert.equal(code(r), 'ok');
  assert.deepEqual(Object.keys(r.body.data).sort(), ['credential', 'session', 'user']);
  assert.equal(r.body.data.user.username, 'Adm_1');
  assert.equal(verifySession(r.body.data.session.token, { keyHex: KEY, env: 'dev', nowSec: nowSecFrom(ctx.now()) }).ok, true);
  // Redeemed, the ticket still answers its grant until the grant's exp: the client polls until a session is issued.
  const after = await call('GET', `/v1/queue/${ticket}`, { headers: as(1) });
  assert.equal(code(after), 'ok', 'redeemed: a poll still answers the grant');
  assert.equal(after.body.data.grant, grant);
});

test('a queued account creation is granted and redeemed at /v1/accounts', { skip }, async () => {
  admissionOn();
  run(5);
  await drainBucket(91);
  const body = { username: 'Adm_New', email: 'admnew@example.com', password: PASSWORD };
  const queued = await call('POST', '/v1/accounts', { headers: as(4), body });
  assert.equal(code(queued), 'queued');
  run(2);
  const { grant } = (await call('GET', `/v1/queue/${queued.body.queued.ticket}`, { headers: as(4) })).body.data;
  const r = await call('POST', '/v1/accounts', { headers: as(4), body: { ...body, grant } });
  assert.equal(code(r), 'ok');
  assert.equal(r.body.data.user.username, 'Adm_New');
  assert.ok(r.body.data.credential);
});

test('a refresh within session_refresh_grace_sec skips the line; a plain restore queues', { skip }, async () => {
  admissionOn({ rate_per_min: 1 });
  run(5);
  await drainBucket(92);
  const u = ctx.u2;
  assert.equal(code(await call('POST', '/v1/session', { headers: as(5), body: { login: { id: 'x', password: 'y' } } })), 'queued', 'the line is busy');

  const refresh = await call('POST', '/v1/session', { headers: as(2), body: { credential: u.credential, session: u.session.token } });
  assert.equal(code(refresh), 'ok');
  assert.equal(refresh.body.data.user.id, u.user.id);
  assert.equal(refresh.body.data.credential, undefined);

  const plain = await call('POST', '/v1/session', { headers: as(3), body: { credential: ctx.u3.credential } });
  assert.equal(code(plain), 'queued');
  ctx.plainTicket = plain.body.queued.ticket;
});

test('turning admission off releases the line: the queued restore polls a grant, and sign-ins pass', { skip }, async () => {
  ctx.view.server.admission.enabled = false;
  const polled = await call('GET', `/v1/queue/${ctx.plainTicket}`, { headers: as(3) });
  assert.equal(code(polled), 'ok');
  const r = await call('POST', '/v1/session', { headers: as(3), body: { credential: ctx.u3.credential, grant: polled.body.data.grant } });
  assert.equal(code(r), 'ok');
  assert.equal(code(await call('POST', '/v1/session', { headers: as(1), body: login('Adm_1') })), 'ok');
  assert.ok(ctx.lines.every((l) => !/eyJ/.test(l) && !l.includes(ctx.u3.credential.token)), 'no token in any log line');
});
