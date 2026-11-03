'use strict';
// RJ 458, invite links, against a real database built from migrations/ (Wobble Planet specs/invite-links.md, 2.4):
// 0007's table and its foreign key, the mint (guests included), the lookup, expiry, the sweeps, the cascade on an
// account's delete and on the guest cull, and join_user from a real invite through to a seat. Runs only with RJ_TEST_DB
// set (see migrate.db.test.js); this file uses its own database, <name>_invites. The dev scrub's handling of the table
// is graded by ops/db/test/scrub_snapshot.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { mintInvite, findInvite, sweepExpiredInvites, INVITE_TTL_SEC } = require('../src/storage/invites');
const { deleteUser } = require('../src/storage');
const { createGuestCull } = require('../src/guests/cull');
const { SESSION_KEY, FP_A, ENV, makeRegistry, quietLogger, beat } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const DAY_MS = 24 * 60 * 60 * 1000;
const ctx = {};
let installSeq = 0;
const install = () => `6f1c2b8e-0000-4000-8458-${String(++installSeq).padStart(12, '0')}`;

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_invites`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  // latin1, as the box's databases are (0001's tables are latin1): the invites table is utf8mb4 beside them.
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  const r = await migrate(c, { log: () => {} });
  assert.ok(r.applied.includes('0007_invites.sql'), r.applied.join(', '));
  ctx.conn = c;
  ctx.admin = admin;
  ctx.name = name;
  initDB({ ...auth, database: name });

  ctx.lines = [];
  ctx.restore = [];
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    console[m] = (...a) => ctx.lines.push(a.join(' '));
    ctx.restore.push(() => { console[m] = orig; });
  }
  ctx.m = makeRegistry({ logger: quietLogger() });
  ctx.view = ctx.m.view;
  ctx.view.server.rate_limits = { ...ctx.view.server.rate_limits, login_per_min_ip: 10000, login_per_min_account: 100, guest_per_day_ip: 10000 };
  const remote = createRemoteConfig({ env: 'dev', url: null, log: { info() {}, warn() {}, error() {} } });
  remote._set(ctx.view);
  ctx.pub = await new Promise((resolve) => {
    const env = { ...ENV, SESSION_KEY, JOIN_URL_BASE: 'https://join.riftjumpers.space/dev' };
    const app = createPublicApp(null, { v1: { env, remote, now: () => ctx.m.clock.t, match: ctx.m.reg } });
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.pub.close();
  await getDB().end();
  await ctx.conn.end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.name}\``);
  await ctx.admin.end();
});

function headers(inst, token) {
  const h = {
    'X-RJ-Api': '1', 'X-RJ-Build': '1', 'X-RJ-Wire': '17', 'X-RJ-Wire-Fp': FP_A, 'X-RJ-Env': 'dev',
    'X-RJ-Platform': 'android', 'X-RJ-Install': inst,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function call(method, urlPath, { body, token, inst = install(), bare = false } = {}) {
  const init = { method, headers: bare ? {} : headers(inst, token) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`http://127.0.0.1:${ctx.pub.address().port}${urlPath}`, init);
  return { status: r.status, body: await r.json() };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

async function q(sql, params = []) {
  const [rows] = await getDB().query(sql, params);
  return rows;
}

async function invitesOf(uid) {
  return Number((await q('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?', [uid]))[0].n);
}

async function newAccount(username) {
  const inst = install();
  const r = await call('POST', '/v1/accounts', { body: { username, email: `${username.toLowerCase()}@example.test`, password: 'a real pilot password' }, inst });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return { id: r.body.data.user.id, username, session: r.body.data.session.token, inst };
}

async function newGuest() {
  const inst = install();
  const r = await call('POST', '/v1/accounts', { body: { guest: true }, inst });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return { id: r.body.data.user.id, username: r.body.data.user.username, session: r.body.data.session.token, inst };
}

async function mint(who) {
  const r = await call('POST', '/v1/me/invites', { body: {}, token: who.session, inst: who.inst });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return r.body.data.invite;
}

const lookup = (id) => call('GET', `/v1/invites/${id}`, { bare: true });

test('0007: invites with users.user_id\'s exact type, a cascading foreign key, its two keys; and it runs again cleanly', { skip }, async () => {
  const [[users]] = await ctx.conn.query(
    "SELECT COLUMN_TYPE AS t FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'");
  const [cols] = await ctx.conn.query(
    `SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invites' ORDER BY ORDINAL_POSITION`);
  assert.deepEqual(cols.map((x) => [x.c, x.t, x.n]), [
    ['id', 'varchar(16)', 'NO'], ['user_id', users.t, 'NO'], ['created_at', 'datetime(3)', 'NO'], ['expires_at', 'datetime(3)', 'NO'],
  ]);
  const [keys] = await ctx.conn.query(
    `SELECT INDEX_NAME AS k, GROUP_CONCAT(COLUMN_NAME) AS cols FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invites' GROUP BY INDEX_NAME ORDER BY INDEX_NAME`);
  assert.deepEqual(keys.map((x) => [x.k, x.cols]), [
    ['ix_invites_expires_at', 'expires_at'], ['ix_invites_user_id', 'user_id'], ['PRIMARY', 'id'],
  ]);
  const [[fk]] = await ctx.conn.query(
    `SELECT REFERENCED_TABLE_NAME AS t, DELETE_RULE AS d FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'invites'`);
  assert.deepEqual([fk.t, fk.d], ['users', 'CASCADE']);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0007_invites.sql'), 'utf8');
  await ctx.conn.query(sql);
  const [again] = await ctx.conn.query(
    "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invites'");
  assert.equal(Number(again[0].n), 4);
});

test('mint: one new row per call, live for 24 h from the mint by the brain\'s clock; a guest mints too', { skip }, async () => {
  const a = await newAccount('Inviter_One');
  const t0 = ctx.m.clock.t;
  const i1 = await mint(a);
  const i2 = await mint(a);
  assert.notEqual(i1.id, i2.id);
  assert.equal(i1.url, `https://join.riftjumpers.space/dev/${i1.id}`);
  assert.equal(i1.expires_in, INVITE_TTL_SEC);
  const [row] = await q('SELECT user_id, CAST(created_at AS CHAR) AS c, CAST(expires_at AS CHAR) AS e FROM invites WHERE id = ?', [i1.id]);
  const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
  assert.deepEqual([Number(row.user_id), row.c, row.e], [a.id, sqlTime(t0), sqlTime(t0 + DAY_MS)]);
  assert.equal(await invitesOf(a.id), 2);

  const g = await newGuest();
  const gi = await mint(g);
  assert.equal((await lookup(gi.id)).body.data.inviter.username, g.username);
  ctx.a = a;
  ctx.aInvite = i1;
  ctx.guest = g;
});

test('lookup: valid with the inviter\'s name and the seconds left; unknown is {valid: false}; expiry by the clock', { skip }, async () => {
  const r = await lookup(ctx.aInvite.id);
  assert.deepEqual(r.body, { result: 'ok', data: { valid: true, inviter: { username: 'Inviter_One' }, expires_in: INVITE_TTL_SEC } });
  assert.deepEqual((await lookup('zzzzzzzzzz')).body.data, { valid: false });
  ctx.m.advance(DAY_MS - 1000);
  assert.equal((await lookup(ctx.aInvite.id)).body.data.expires_in, 1);
  const b = await newAccount('Follower_One');
  const before = await call('POST', '/v1/match/join', { body: { mode: 'join_user', invite: ctx.aInvite.id }, token: b.session, inst: b.inst });
  assert.equal(before.body.queued.kind, 'follow', 'still live: a follow');
  ctx.m.advance(1000);
  assert.deepEqual((await lookup(ctx.aInvite.id)).body.data, { valid: false });
  const after = await call('POST', '/v1/match/join', { body: { mode: 'join_user', invite: ctx.aInvite.id }, token: b.session, inst: b.inst });
  assert.equal(code(after), 'INVITE_INVALID');
  assert.equal(after.status, 404);
  ctx.b = b;
});

test('expired rows are swept: a few at every mint, the rest by the sweep; live rows stay', { skip }, async () => {
  const now = ctx.m.clock.t;
  const expired = Number((await q('SELECT COUNT(*) AS n FROM invites WHERE expires_at <= ?', [new Date(now).toISOString().replace('T', ' ').replace('Z', '')]))[0].n);
  assert.ok(expired >= 2, `the measurement: ${expired} expired rows to sweep`);
  for (let i = 0; i < 3; i++) await mintInvite(ctx.b.id, { now: now - 2 * DAY_MS });
  const total = Number((await q('SELECT COUNT(*) AS n FROM invites'))[0].n);
  assert.equal(await sweepExpiredInvites({ now, limit: 2 }), 2, 'at most its batch');
  const left = await sweepExpiredInvites({ now });
  assert.equal(total - 2 - left, Number((await q('SELECT COUNT(*) AS n FROM invites'))[0].n));
  assert.equal(await sweepExpiredInvites({ now }), 0);
  // A mint sweeps what has expired since.
  const live = await mintInvite(ctx.b.id, { now });
  await mintInvite(ctx.b.id, { now: now - 2 * DAY_MS });
  assert.equal(await invitesOf(ctx.b.id), 2);
  await mintInvite(ctx.b.id, { now });
  assert.equal(await invitesOf(ctx.b.id), 2, 'the expired one went with the mint');
  assert.ok(await findInvite(live.id, { now }));
});

test('the cascade: an account\'s delete takes its invites (DELETE /v1/me, and a bare DELETE FROM users); a gone account mints nothing', { skip }, async () => {
  const c = await newAccount('Deleted_Inviter');
  const ic = await mint(c);
  await mint(c);
  const r = await call('DELETE', '/v1/me', { body: { password: 'a real pilot password' }, token: c.session, inst: c.inst });
  assert.equal(code(r), 'ok');
  assert.equal(await invitesOf(c.id), 0);
  assert.deepEqual((await lookup(ic.id)).body.data, { valid: false });
  const again = await call('POST', '/v1/me/invites', { body: {}, token: c.session, inst: c.inst });
  assert.equal(code(again), 'AUTH_INVALID', 'the session outlives the account by up to an hour; the foreign key refuses the row');
  assert.equal(await invitesOf(c.id), 0);

  const d = await newAccount('Raw_Delete');
  await mint(d);
  await q('DELETE FROM user_credentials WHERE user_id = ?', [d.id]);
  await q('DELETE FROM user_player_card WHERE user_id = ?', [d.id]);
  await q('DELETE FROM user_accolades_time_earned WHERE user_id = ?', [d.id]);
  await q('DELETE FROM user_accolades WHERE user_id = ?', [d.id]);
  await q('DELETE FROM user_stats WHERE user_id = ?', [d.id]);
  assert.equal(await invitesOf(d.id), 1);
  await q('DELETE FROM users WHERE user_id = ?', [d.id]);
  assert.equal(await invitesOf(d.id), 0, 'ON DELETE CASCADE');

  const e = await newAccount('Store_Delete');
  await mint(e);
  assert.equal(await deleteUser(e.id), true);
  assert.equal(await invitesOf(e.id), 0);
});

test('the guest cull takes an idle guest\'s invites with it', { skip }, async () => {
  const g = ctx.guest;
  // Its first invite has expired and been swept by now (the clock moved a day on); a live one, minted now:
  await mintInvite(g.id, { now: ctx.m.clock.t });
  assert.equal(await invitesOf(g.id), 1);
  await q('UPDATE users SET last_login = NOW() - INTERVAL 8 DAY, created_date = NOW() - INTERVAL 8 DAY WHERE user_id = ?', [g.id]);
  await q('UPDATE user_credentials SET last_used_at = NOW() - INTERVAL 8 DAY WHERE user_id = ?', [g.id]);
  const cull = createGuestCull({ config: () => ctx.view, match: ctx.m.reg, logger: quietLogger() });
  const r = await cull.sweep();
  assert.ok(r.culled >= 1, JSON.stringify(r));
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM users WHERE user_id = ?', [g.id]))[0].n), 0);
  assert.equal(await invitesOf(g.id), 0);
});

test('join_user from a real invite: follow, the inviter quickplays, both in one lobby; the inviter\'s own invite is VALIDATION', { skip }, async () => {
  const a = await newAccount('Host_Pilot');
  const b = await newAccount('Friend_Pilot');
  const inv = await mint(a);
  const self = await call('POST', '/v1/match/join', { body: { mode: 'join_user', invite: inv.id }, token: a.session, inst: a.inst });
  assert.deepEqual([code(self), self.body.error.message], ['VALIDATION', "That's your own invite."]);
  const f = await call('POST', '/v1/match/join', { body: { mode: 'join_user', invite: inv.id }, token: b.session, inst: b.inst });
  assert.deepEqual([f.body.queued.kind, f.body.queued.message], ['follow', 'Waiting for Host_Pilot to start a match...']);
  const qa = await call('POST', '/v1/match/join', { body: { mode: 'quickplay' }, token: a.session, inst: a.inst });
  const lobby = [...ctx.m.reg.lobbies.values()].find((l) => l.state === 'BOOTING');
  assert.ok(lobby, code(qa));
  await ctx.m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const pa = await call('GET', `/v1/queue/${qa.body.queued.ticket}`, { inst: a.inst });
  const pb = await call('GET', `/v1/queue/${f.body.queued.ticket}`, { inst: b.inst });
  assert.deepEqual([code(pa), code(pb)], ['ok', 'ok']);
  assert.equal(pa.body.data.port, pb.body.data.port);
});
