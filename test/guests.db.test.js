'use strict';
// RJ 493, guest accounts, against a real database built from migrations/: POST /v1/accounts {guest: true} and its
// generated names, user.guest everywhere a user is returned, a password login never matching a guest, the reserved
// Pilot-NNNN names, POST /v1/me/upgrade, the leaderboards leaving guests out, a guest's delete with no password, and
// the cull (its activity rule, the registry's seats and tickets, the guard under the row lock). Runs only with
// RJ_TEST_DB set (see migrate.db.test.js); this file uses its own database, <name>_guests.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { verifySession } = require('../src/auth/tokens');
const { createGuest, deleteUser, loginUser } = require('../src/storage');
const { createGuestCull } = require('../src/guests/cull');
const { SESSION_KEY, FP_A, ENV, makeRegistry, quietLogger } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const PASSWORD = 'a real pilot password';
const ctx = {};
let installSeq = 0;
const install = () => `6f1c2b8e-0000-4000-8000-${String(++installSeq).padStart(12, '0')}`;

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_guests`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  const r = await migrate(c, { log: () => {} });
  assert.ok(r.applied.includes('0004_guests.sql'), r.applied.join(', '));
  await c.end();
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
    const app = createPublicApp(null, { v1: { env: { ...ENV, SESSION_KEY }, remote, now: () => ctx.m.clock.t, match: ctx.m.reg } });
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.pub.close();
  await getDB().end();
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

async function call(method, path, { body, token, inst = install() } = {}) {
  const init = { method, headers: headers(inst, token) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`http://127.0.0.1:${ctx.pub.address().port}${path}`, init);
  return { status: r.status, body: await r.json() };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

async function q(sql, params = []) {
  const [rows] = await getDB().query(sql, params);
  return rows;
}

async function rowCounts(uid) {
  const out = {};
  for (const t of ['users', 'user_credentials', 'user_player_card', 'user_accolades_time_earned', 'user_accolades', 'user_stats']) {
    out[t] = Number((await q(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [uid]))[0].n);
  }
  return out;
}

async function newGuest() {
  const inst = install();
  const r = await call('POST', '/v1/accounts', { body: { guest: true }, inst });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  const d = r.body.data;
  return { id: d.user.id, username: d.user.username, session: d.session.token, credential: d.credential, inst, data: d };
}

async function newAccount(username) {
  const inst = install();
  const r = await call('POST', '/v1/accounts', { body: { username, email: `${username.toLowerCase()}@example.test`, password: PASSWORD }, inst });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return { id: r.body.data.user.id, username, session: r.body.data.session.token, credential: r.body.data.credential, inst, data: r.body.data };
}

test('POST /v1/accounts {guest: true}: a Pilot-NNNN with no email or password, its four rows and a credential', { skip }, async () => {
  const g = await newGuest();
  assert.deepEqual(Object.keys(g.data).sort(), ['credential', 'session', 'user']);
  assert.deepEqual(Object.keys(g.data.user).sort(), ['guest', 'id', 'username']);
  assert.equal(g.data.user.guest, true);
  assert.match(g.username, /^Pilot-\d{4}$/);
  assert.equal(g.data.session.expires_in, 3600);
  assert.equal(verifySession(g.session, { keyHex: SESSION_KEY, env: 'dev', nowSec: Math.floor(ctx.m.clock.t / 1000) }).payload.uid, g.id);
  assert.equal(g.credential.user_id, g.id);
  const [u] = await q('SELECT username, email, password, is_guest, last_login, created_date FROM users WHERE user_id = ?', [g.id]);
  assert.deepEqual([u.username, u.email, u.password, u.is_guest], [g.username, null, null, 1]);
  assert.ok(u.last_login && u.created_date);
  assert.deepEqual(await rowCounts(g.id), {
    users: 1, user_credentials: 1, user_player_card: 1, user_accolades_time_earned: 1, user_accolades: 1, user_stats: 1,
  });
  const [c] = await q('SELECT token_hash FROM user_credentials WHERE user_id = ?', [g.id]);
  assert.equal(c.token_hash, crypto.createHash('sha256').update(g.credential.token).digest('hex'));
  ctx.g1 = g;
});

test('many guests side by side: distinct names, any number of NULL emails and passwords', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push((await newGuest()).id);
  const [r] = await q(`SELECT COUNT(*) AS n, COUNT(DISTINCT username) AS names FROM users WHERE is_guest = 1 AND email IS NULL AND password IS NULL`);
  assert.deepEqual([Number(r.n), Number(r.names)], [26, 26]);
  assert.equal(new Set(ids).size, 25);
});

test('a name collision retries, widens to six digits after three, and gives up whole', { skip }, async () => {
  const at = (four, six) => (lo, hi) => (hi === 10000 ? four : six);
  const a = await createGuest({ platform: 'ios', installId: 'i' }, { randomInt: at(42, 1) });
  assert.equal(a.username, 'Pilot-0042');
  const b = await createGuest({ platform: 'ios', installId: 'i' }, { randomInt: at(42, 123456) });
  assert.equal(b.username, 'Pilot-123456', 'three four-digit collisions, then six digits');
  const before = Number((await q('SELECT COUNT(*) AS n FROM users'))[0].n);
  await assert.rejects(createGuest({ platform: 'ios', installId: 'i' }, { randomInt: at(42, 123456) }), /no free guest username/);
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM users'))[0].n), before, 'nothing left behind');
  ctx.pilot42 = a;
});

test('user.guest on every user: a guest\'s restore true; an account, its login and restore false', { skip }, async () => {
  const g = ctx.g1;
  await q('UPDATE user_credentials SET last_used_at = NULL WHERE user_id = ?', [g.id]);
  const restore = await call('POST', '/v1/session', { body: { credential: g.credential }, inst: g.inst });
  assert.deepEqual(restore.body.data.user, { id: g.id, username: g.username, guest: true });
  assert.ok((await q('SELECT last_used_at FROM user_credentials WHERE user_id = ?', [g.id]))[0].last_used_at !== null,
    'a restore is the guest\'s activity');

  const a = await newAccount('Real_Ace');
  assert.deepEqual(a.data.user, { id: a.id, username: 'Real_Ace', guest: false });
  const login = await call('POST', '/v1/session', { body: { login: { id: 'Real_Ace', password: PASSWORD } } });
  assert.deepEqual(login.body.data.user, { id: a.id, username: 'Real_Ace', guest: false });
  const r = await call('POST', '/v1/session', { body: { credential: a.credential } });
  assert.deepEqual(r.body.data.user, { id: a.id, username: 'Real_Ace', guest: false });
  ctx.ace = a;
});

test('a password login never matches a guest, whatever is typed (the stand-in hash\'s own password included)', { skip }, async () => {
  for (const password of ['x', 'rift-jumpers-no-such-user']) {
    for (const id of [ctx.pilot42.username, 'pilot-0042']) {
      const r = await call('POST', '/v1/session', { body: { login: { id, password } } });
      assert.deepEqual([code(r), r.status], ['AUTH_INVALID', 401], `${id} / ${password}`);
    }
  }
  // The legacy login (the legacy brain's code, shared): refused, never a bcrypt crash on a NULL hash.
  await assert.rejects(loginUser({ user_credential: ctx.pilot42.username, password: 'rift-jumpers-no-such-user' }), /^Error: Invalid password$/);
  const n = ctx.lines.filter((l) => /Illegal arguments/.test(l)).length;
  assert.equal(n, 0);
});

test('reserved names: account creation refuses Pilot-NNNN and its spellings, after the bad words, before taken', { skip }, async () => {
  for (const username of ['Pilot-1234', 'pilot99', 'PILOT-7', ' Pilot-5 ', ctx.pilot42.username]) {
    const r = await call('POST', '/v1/accounts', { body: { username, email: `${crypto.randomUUID()}@x.test`, password: PASSWORD } });
    assert.deepEqual([code(r), r.body.error.message], ['VALIDATION', 'That username is reserved.'], username);
  }
  for (const username of ['Pilot_One', 'Pilot-12a', 'Copilot-12', 'Pilot']) {
    const r = await call('POST', '/v1/accounts', { body: { username, email: `${crypto.randomUUID()}@x.test`, password: PASSWORD } });
    assert.equal(code(r), 'ok', username);
  }
  assert.equal(Number((await q("SELECT COUNT(*) AS n FROM users WHERE username = 'Pilot-1234'"))[0].n), 0);
});

test('POST /v1/me/upgrade: the same row gets a login; id, credential, session and stats stay', { skip }, async () => {
  const g = await newGuest();
  const future = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(code(await call('POST', '/v1/me/sp-stats/sync', { token: g.session, body: { stats: { _last_updated: future, sp_most_jumps_in_a_run: 321 } } })), 'ok');
  const body = { username: 'Upgraded_One', email: 'up1@example.test', password: PASSWORD };
  const r = await call('POST', '/v1/me/upgrade', { token: g.session, body });
  assert.deepEqual(r.body, { result: 'ok', data: { user: { id: g.id, username: 'Upgraded_One', guest: false } } });
  const [u] = await q('SELECT username, email, password, is_guest FROM users WHERE user_id = ?', [g.id]);
  assert.deepEqual([u.username, u.email, u.is_guest], ['Upgraded_One', 'up1@example.test', 0]);
  assert.match(u.password, /^\$2[aby]\$10\$/);
  assert.equal((await q('SELECT sp_most_jumps_in_a_run AS v FROM user_stats WHERE user_id = ?', [g.id]))[0].v, 321);

  const restore = await call('POST', '/v1/session', { body: { credential: g.credential }, inst: g.inst });
  assert.deepEqual(restore.body.data.user, { id: g.id, username: 'Upgraded_One', guest: false }, 'the guest\'s credential, unchanged');
  const login = await call('POST', '/v1/session', { body: { login: { id: 'up1@example.test', password: PASSWORD } } });
  assert.deepEqual(login.body.data.user, { id: g.id, username: 'Upgraded_One', guest: false });
  assert.equal(code(await call('POST', '/v1/me/sp-stats/sync', { token: g.session, body: { stats: {} } })), 'ok', 'the session still works');

  const again = await call('POST', '/v1/me/upgrade', { token: g.session, body: { ...body, username: 'Upgraded_Two', email: 'up2@example.test' } });
  assert.deepEqual([code(again), again.body.error.message], ['VALIDATION', 'This account already has a login.']);
  const real = await call('POST', '/v1/me/upgrade', { token: ctx.ace.session, body: { ...body, username: 'Ace_Two', email: 'ace2@example.test' } });
  assert.deepEqual([code(real), real.body.error.message], ['VALIDATION', 'This account already has a login.']);
  ctx.upgraded = { ...g, username: 'Upgraded_One' };
});

test('the upgrade\'s rules: a taken name or email, a reserved name, a missing field; nothing changes', { skip }, async () => {
  const g = await newGuest();
  const at = (body) => call('POST', '/v1/me/upgrade', { token: g.session, body });
  const cases = [
    [{ username: 'Upgraded_One', email: 'fresh1@example.test', password: PASSWORD }, 'This username "Upgraded_One" is already taken.'],
    [{ username: 'Fresh_One', email: 'up1@example.test', password: PASSWORD }, 'This email is already registered.'],
    [{ username: 'Pilot-4321', email: 'fresh2@example.test', password: PASSWORD }, 'That username is reserved.'],
    [{ username: 'Fresh_Two', email: 'not an email', password: PASSWORD }, 'Invalid email format: not an email'],
    [{ username: 'Fresh_Three', email: 'fresh3@example.test' }, 'Missing required field: password'],
  ];
  for (const [body, message] of cases) {
    const r = await at(body);
    assert.deepEqual([code(r), r.body.error.message], ['VALIDATION', message], JSON.stringify(body));
  }
  const [u] = await q('SELECT username, email, password, is_guest FROM users WHERE user_id = ?', [g.id]);
  assert.deepEqual([u.username, u.email, u.password, u.is_guest], [g.username, null, null, 1]);
  assert.equal(code(await at({ username: 'Fresh_Four', email: 'fresh4@example.test', password: PASSWORD })), 'ok', 'then a good one');
});

test('leaderboards leave guests out: the list, the rank and `user`; an upgraded guest is on them', { skip }, async () => {
  const g = await newGuest();
  const top = await newAccount('Board_Top');
  await q('UPDATE user_stats SET sp_highest_combo_alltime = 0');
  await q('UPDATE user_stats SET sp_highest_combo_alltime = 900 WHERE user_id = ?', [g.id]);
  await q('UPDATE user_stats SET sp_highest_combo_alltime = 800 WHERE user_id = ?', [ctx.g1.id]);
  await q('UPDATE user_stats SET sp_highest_combo_alltime = 500 WHERE user_id = ?', [top.id]);
  await q('UPDATE user_stats SET sp_highest_combo_alltime = 400 WHERE user_id = ?', [ctx.upgraded.id]);
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM user_stats us JOIN users u USING (user_id) WHERE u.is_guest = 1 AND us.sp_highest_combo_alltime > 500');
  assert.equal(Number(n), 2, 'the measurement: two guests outscore everyone');

  const board = await call('GET', `/v1/leaderboards/sp_highest_combo_alltime?limit=3&user_id=${top.id}`);
  assert.deepEqual(board.body.data.list.map((e) => [e.username, e.score, e.rank]), [['Board_Top', 500, 1], ['Upgraded_One', 400, 2], [board.body.data.list[2].username, 0, 3]]);
  assert.deepEqual(board.body.data.user, { user_id: top.id, username: 'Board_Top', score: 500, rank: 1 }, 'no guest counted above');
  const mine = await call('GET', `/v1/leaderboards/sp_highest_combo_alltime?user_id=${g.id}`);
  assert.equal(mine.body.data.user, null, 'a guest has no place');
  const full = await call('GET', '/v1/leaderboards/sp_highest_combo_alltime?limit=100');
  assert.equal(full.body.data.list.some((e) => /^Pilot-\d+$/.test(e.username)), false);
  const stats = await call('GET', `/v1/users/${g.id}/stats`);
  assert.equal(stats.body.data.sp_highest_combo_alltime, 900, 'a guest\'s own stats still read');
});

test('DELETE /v1/me: a guest needs no password, and is gone', { skip }, async () => {
  const g = await newGuest();
  const r = await call('DELETE', '/v1/me', { token: g.session, body: {} });
  assert.deepEqual(r.body, { result: 'ok', data: {} });
  assert.deepEqual(Object.values(await rowCounts(g.id)), [0, 0, 0, 0, 0, 0]);
  assert.ok(ctx.lines.includes(`[account] user ${g.id} deleted`));
  assert.equal(code(await call('DELETE', '/v1/me', { token: ctx.ace.session, body: {} })), 'VALIDATION', 'an account with a login still needs it');
});

test('the cull: idle guests go; recent activity of any kind, a seat or ticket, or a login keeps an account', { skip }, async () => {
  const backdate = (uid, days) => Promise.all([
    q('UPDATE users SET last_login = NOW() - INTERVAL ? DAY, created_date = NOW() - INTERVAL ? DAY WHERE user_id = ?', [days, days + 1, uid]),
    q('UPDATE user_credentials SET last_used_at = NOW() - INTERVAL ? DAY WHERE user_id = ?', [days, uid]),
  ]);
  const idle = await newGuest();
  const idle2 = await newGuest();
  const recentRestore = await newGuest();
  const recentLogin = await newGuest();
  const holdsTicket = await newGuest();
  const fresh = await newGuest();
  for (const g of [idle, idle2, recentRestore, recentLogin, holdsTicket]) await backdate(g.id, 8);
  await backdate(ctx.ace.id, 30);
  await q('UPDATE user_credentials SET last_used_at = NOW() - INTERVAL 2 DAY WHERE user_id = ?', [recentRestore.id]);
  await q('UPDATE users SET last_login = NOW() - INTERVAL 6 DAY WHERE user_id = ?', [recentLogin.id]);
  const q1 = await ctx.m.reg.join({ mode: 'quickplay', uid: holdsTicket.id, uname: holdsTicket.username, install: holdsTicket.inst, wire: 17, fp: FP_A });
  assert.equal(q1.result, 'queued');
  assert.equal(ctx.m.reg.holds(holdsTicket.id), true);
  // Every older guest from the tests above is idle too, by its created_date.
  await q('UPDATE users SET last_login = NOW() - INTERVAL 30 DAY, created_date = NOW() - INTERVAL 30 DAY WHERE is_guest = 1 AND user_id < ?', [idle.id]);
  await q('UPDATE user_credentials SET last_used_at = NOW() - INTERVAL 30 DAY WHERE user_id < ?', [idle.id]);
  const older = (await q('SELECT user_id FROM users WHERE is_guest = 1 AND user_id < ?', [idle.id])).map((r) => r.user_id);
  assert.ok(older.length > 20);

  const logger = quietLogger();
  const cull = createGuestCull({ config: () => ctx.view, match: ctx.m.reg, logger, batch: 1000 });
  const r = await cull.sweep();
  assert.deepEqual(r, { culled: older.length + 2, held: 1 });
  assert.deepEqual(logger.lines, [`[guests] culled ${older.length + 2} idle guest(s)`]);
  const left = new Set((await q('SELECT user_id FROM users')).map((x) => x.user_id));
  for (const g of [idle, idle2]) assert.equal(left.has(g.id), false, `idle guest ${g.id}`);
  for (const id of older) assert.equal(left.has(id), false, `older guest ${id}`);
  for (const g of [recentRestore, recentLogin, holdsTicket, fresh, ctx.ace, ctx.upgraded]) assert.equal(left.has(g.id), true, g.username);
  assert.deepEqual(Object.values(await rowCounts(idle.id)), [0, 0, 0, 0, 0, 0], 'through the account deletion: every row');
  assert.deepEqual(await cull.sweep(), { culled: 0, held: 1 }, 'nothing more to cull');

  ctx.view.server.guest_cull_days = 1;
  assert.deepEqual(await cull.sweep(), { culled: 2, held: 1 }, 'a shorter window, read live: the two touched days ago go too');
  ctx.view.server.guest_cull_days = 7;
});

test('the cull\'s guard under the row lock: an account no longer an idle guest is kept', { skip }, async () => {
  const g = await newGuest();
  assert.equal(await deleteUser(g.id, { idleGuestDays: 7 }), false, 'a new guest is not idle');
  await q('UPDATE users SET last_login = NOW() - INTERVAL 9 DAY, created_date = NOW() - INTERVAL 9 DAY WHERE user_id = ?', [g.id]);
  await q('UPDATE user_credentials SET last_used_at = NOW() - INTERVAL 9 DAY WHERE user_id = ?', [g.id]);
  await q('UPDATE users SET is_guest = 0 WHERE user_id = ?', [g.id]);
  assert.equal(await deleteUser(g.id, { idleGuestDays: 7 }), false, 'upgraded meanwhile');
  await q('UPDATE users SET is_guest = 1 WHERE user_id = ?', [g.id]);
  await q('UPDATE user_credentials SET last_used_at = NOW() WHERE user_id = ?', [g.id]);
  assert.equal(await deleteUser(g.id, { idleGuestDays: 7 }), false, 'came back meanwhile');
  await q('UPDATE user_credentials SET last_used_at = NOW() - INTERVAL 9 DAY WHERE user_id = ?', [g.id]);
  assert.equal(await deleteUser(g.id, { idleGuestDays: 7 }), true, 'still idle: deleted');
});

test('guest_play false at the brain: no new guests; existing ones still restore and play', { skip }, async () => {
  const g = await newGuest();
  ctx.view.flags.guest_play = false;
  try {
    const r = await call('POST', '/v1/accounts', { body: { guest: true } });
    assert.deepEqual([code(r), r.body.error.message], ['VALIDATION', 'Guest play is off right now. Log in or create an account.']);
    const restore = await call('POST', '/v1/session', { body: { credential: g.credential }, inst: g.inst });
    assert.deepEqual(restore.body.data.user, { id: g.id, username: g.username, guest: true });
    const join = await call('POST', '/v1/match/join', { token: g.session, body: { mode: 'quickplay' }, inst: g.inst });
    assert.ok(['ok', 'queued'].includes(code(join)), JSON.stringify(join.body));
  } finally {
    ctx.view.flags.guest_play = true;
  }
  assert.equal(code(await call('POST', '/v1/accounts', { body: { guest: true } })), 'ok');
});

test('no password, credential or session token reached the log', { skip }, () => {
  const text = ctx.lines.join('\n');
  assert.ok(ctx.lines.some((l) => l.startsWith('[v1] r-')), 'the request lines were captured (the measurement works)');
  for (const secret of [PASSWORD, ctx.g1.credential.token, ctx.g1.session]) assert.ok(!text.includes(secret));
});
