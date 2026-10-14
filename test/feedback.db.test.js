'use strict';
// The feedback table (RJ 488) and its sheet store (RJ 489) against a real database built from migrations/. Runs only
// with RJ_TEST_DB set (see migrate.db.test.js); this file uses its own database, <name>_feedback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { signSession } = require('../src/auth/tokens');
const storage = require('../src/storage');
const { createFeedbackSheetStore, insertFeedback, anonymizeFeedbackForUser } = require('../src/storage/feedback');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const KEY = '5b'.repeat(32);
const INSTALL = '6f1c2b8e-0000-4000-8000-0000000000aa';
const HEADERS = { 'X-RJ-Api': '1', 'X-RJ-Build': '120', 'X-RJ-Env': 'dev', 'X-RJ-Platform': 'android', 'X-RJ-Install': INSTALL };
const ctx = {};
let seq = 0;
const uuid = () => `11111111-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_feedback`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  // The server's default charset (latin1 on mariadb:10.11), as on the box: the table must carry its own.
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const conn = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  const r = await migrate(conn, { log: () => {} });
  assert.ok(r.applied.includes('0003_feedback.sql'), r.applied.join(', '));
  ctx.conn = conn;
  ctx.admin = admin;
  ctx.name = name;
  initDB({ ...auth, database: name });
  await getDB().query("INSERT INTO users (username, email, password) VALUES ('Pilot_Ünï', 'p@x.io', 'h')");
  const [[u]] = await getDB().query("SELECT user_id FROM users WHERE email = 'p@x.io'");
  ctx.uid = u.user_id;

  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
  ctx.clock = { ms: Date.UTC(2026, 9, 14, 18, 0, 0, 250) };
  const remote = createRemoteConfig({ env: 'dev', url: null, log: { info() {}, warn() {}, error() {} } });
  remote._set(defaultView('dev'));
  const app = createPublicApp(null, { v1: { env: { ENV: 'dev', SESSION_KEY: KEY }, remote, now: () => ctx.clock.ms } });
  ctx.server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  ctx.server.close();
  await getDB().end();
  await ctx.conn.end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.name}\``);
  await ctx.admin.end();
});

async function send(body, { token } = {}) {
  const h = { ...HEADERS, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${ctx.base}/v1/feedback`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return JSON.parse(await r.text());
}

async function row(id) {
  const [rows] = await getDB().query('SELECT *, CAST(received_at AS CHAR) AS received_s FROM feedback WHERE id = ?', [id]);
  return rows[0];
}

test('0003 is idempotent: running it again changes nothing', { skip }, async () => {
  await ctx.conn.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0003_feedback.sql'), 'utf8'));
  const [[t]] = await ctx.conn.query(
    "SELECT TABLE_COLLATION AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback'");
  assert.equal(t.c, 'utf8mb4_unicode_ci');
  const [[c]] = await ctx.conn.query(
    "SELECT COLUMN_TYPE AS t FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' AND COLUMN_NAME = 'user_id'");
  const [[u]] = await ctx.conn.query(
    "SELECT COLUMN_TYPE AS t FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'");
  assert.equal(c.t, u.t, "users.user_id's type");
});

test('an emoji message round-trips, cut at 2000 code points, and received_at is UTC to the millisecond', { skip }, async () => {
  const id = uuid();
  const message = `🎮 jump felt laggy 🚀👩‍🚀 ${'😀'.repeat(2100)}`;
  const r = await send({ id, message, tags: ['bug', 'fun'], written_at: '2026-10-14T17:59:00.000Z', context: { where: 'pause_sp', device: { model: 'Pixel 8 — Pro' } } });
  assert.deepEqual(r, { result: 'ok', data: { id, received_at: '2026-10-14T18:00:00.250Z' } });
  const got = await row(id);
  assert.equal(got.message, [...message].slice(0, 2000).join(''));
  assert.equal([...got.message].length, 2000);
  assert.equal(got.received_s, '2026-10-14 18:00:00.250');
  assert.deepEqual(JSON.parse(got.context), { where: 'pause_sp', device: { model: 'Pixel 8 — Pro' } });
  assert.deepEqual([got.tags, got.user_id, got.username, got.install_id, got.build, got.platform, got.env, got.sheet_state],
    ['bug,fun', null, null, INSTALL, 120, 'android', 'dev', 'pending']);
  assert.equal(got.ip, '127.0.0.1');
});

test('a signed-in entry carries the user and their username (utf8mb4 from a latin1 users table)', { skip }, async () => {
  const id = uuid();
  const token = signSession({ uid: ctx.uid, env: 'dev', nowSec: Math.floor(ctx.clock.ms / 1000), keyHex: KEY }).token;
  assert.equal((await send({ id, message: 'signed in' }, { token })).result, 'ok');
  const got = await row(id);
  assert.deepEqual([got.user_id, got.username], [ctx.uid, 'Pilot_Ünï']);
});

test('a repeat id, and a duplicate-key race, answer ok and keep the first row', { skip }, async () => {
  const id = uuid();
  await send({ id, message: 'first' });
  ctx.clock.ms += 1000;
  const again = await send({ id, message: 'second' });
  assert.deepEqual(again.data, { id, received_at: '2026-10-14T18:00:00.250Z' });
  assert.equal((await row(id)).message, 'first');

  const race = uuid();
  const base = { id: race, written_at: null, user_id: null, username: null, install_id: null, ip: null, build: null,
    platform: null, env: 'dev', tags: [], context: {} };
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => insertFeedback({ ...base, message: `racer ${i}`, received_ms: ctx.clock.ms + i })));
  assert.equal(results.filter((x) => !x.duplicate).length, 1);
  const winner = await row(race);
  for (const x of results) assert.equal(x.received_at, `${winner.received_s.replace(' ', 'T')}Z`);
  const [[{ n }]] = await getDB().query('SELECT COUNT(*) AS n FROM feedback WHERE id = ?', [race]);
  assert.equal(Number(n), 1);

  const http = uuid();
  const answers = await Promise.all([0, 1, 2].map(() => send({ id: http, message: 'over http' })));
  assert.deepEqual(answers.map((a) => a.result), ['ok', 'ok', 'ok']);
});

test('anonymizeFeedbackForUser: identity gone, sent rows to anon_pending, pending rows stay pending', { skip }, async () => {
  await getDB().query("INSERT INTO users (username, email, password) VALUES ('Leaver', 'l@x.io', 'h')");
  const [[u]] = await getDB().query("SELECT user_id FROM users WHERE email = 'l@x.io'");
  const token = signSession({ uid: u.user_id, env: 'dev', nowSec: Math.floor(ctx.clock.ms / 1000), keyHex: KEY }).token;
  const sent = uuid();
  const pending = uuid();
  const other = uuid();
  await send({ id: sent, message: 'a' }, { token });
  await send({ id: pending, message: 'b' }, { token });
  const othersToken = signSession({ uid: ctx.uid, env: 'dev', nowSec: Math.floor(ctx.clock.ms / 1000), keyHex: KEY }).token;
  await send({ id: other, message: 'c' }, { token: othersToken });
  await getDB().query("UPDATE feedback SET sheet_state = 'sent', sheet_attempts = 3 WHERE id = ?", [sent]);

  assert.equal(typeof storage.anonymizeFeedbackForUser, 'function', 'exported through storage for RJ 473');
  const changed = await anonymizeFeedbackForUser(u.user_id, { now: Date.UTC(2026, 9, 15) });
  assert.equal(changed, 2);
  for (const id of [sent, pending]) {
    const r = await row(id);
    assert.deepEqual([r.user_id, r.username, r.install_id, r.ip], [null, null, null, null], id);
    assert.ok(r.anonymized_at instanceof Date || typeof r.anonymized_at === 'string');
    assert.equal(r.message, id === sent ? 'a' : 'b', 'the feedback itself is kept');
  }
  assert.deepEqual([(await row(sent)).sheet_state, (await row(sent)).sheet_attempts], ['anon_pending', 0]);
  assert.equal((await row(pending)).sheet_state, 'pending');
  assert.equal((await row(other)).user_id, ctx.uid, "another player's rows are untouched");

  await getDB().query('DELETE FROM users WHERE user_id = ?', [u.user_id]);
  assert.equal((await row(sent)).message, 'a', 'no cascade from users');
});

test('the sheet store: due rows oldest first, the IF(anonymized_at) mark, backoff, the daily count', { skip }, async () => {
  await getDB().query("UPDATE feedback SET sheet_state = 'done_anon'");
  const store = createFeedbackSheetStore(getDB());
  const t = Date.UTC(2026, 9, 16, 12, 0, 0);
  const ids = [uuid(), uuid(), uuid()];
  for (const [i, id] of ids.entries()) {
    await insertFeedback({ id, received_ms: t - (3 - i) * 1000, written_at: 'w', user_id: ctx.uid, username: 'Pilot_Ünï',
      install_id: null, ip: '1.2.3.4', build: 5, platform: 'ios', env: 'dev', tags: ['idea'], message: `m${i} 🎮`, context: { where: 'main_menu' } });
  }
  const due = await store.dueForAppend(2, t);
  assert.deepEqual(due.map((r) => r.id), ids.slice(0, 2));
  assert.equal(due[0].received_at, new Date(t - 3000).toISOString());
  assert.equal(due[0].message, 'm0 🎮');
  assert.equal(due[0].anonymized_at, null);
  assert.ok(!('ip' in due[0]), 'the ip never leaves the database');

  // ids[1] is anonymised while its batch is out.
  await anonymizeFeedbackForUser(ctx.uid, { now: t });
  assert.equal(await store.markSent(ids.slice(0, 2), t), 2);
  assert.equal((await row(ids[0])).sheet_state, 'anon_pending', 'anonymised during the batch');
  assert.equal(await store.sentSince(t - 1), 2);
  assert.equal(await store.sentSince(t + 1), 0);

  assert.equal(await store.backoff([ids[2]], 'pending', t, { baseSec: 30, capSec: 3600 }), 1);
  let r = await row(ids[2]);
  assert.equal(r.sheet_attempts, 1);
  assert.deepEqual(await store.dueForAppend(10, t + 29999), []);
  assert.deepEqual((await store.dueForAppend(10, t + 30000)).map((x) => x.id), [ids[2]]);
  await getDB().query('UPDATE feedback SET sheet_attempts = 9 WHERE id = ?', [ids[2]]);
  await store.backoff([ids[2]], 'pending', t, { baseSec: 30, capSec: 3600 });
  assert.deepEqual(await store.dueForAppend(10, t + 3599999), [], 'capped at an hour');
  assert.equal((await store.dueForAppend(10, t + 3600000)).length, 1);
  assert.equal(await store.backoff([ids[2]], 'anon_pending', t, { baseSec: 30, capSec: 3600 }), 0, 'only rows still in that state');

  assert.deepEqual((await store.dueForAnonymize(10, t)).map((x) => x.id), ids.slice(0, 2));
  assert.equal(await store.markAnonDone([ids[0]]), 1);
  r = await row(ids[0]);
  assert.equal(r.sheet_state, 'done_anon');
  assert.equal(await store.markSent([ids[0]], t), 0, 'markSent touches only pending rows');
});
