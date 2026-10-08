'use strict';
// /v1 against a real database built from migrations/ (0001 + 0002). Runs only with RJ_TEST_DB set (see
// migrate.db.test.js); this file uses its own database, <name>_v1, so the two files can run at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp } = require('../src/app');
const { createLobbyRegistry } = require('../src/match/lobbies');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { verifySession, signSession } = require('../src/auth/tokens');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const KEY = '5a'.repeat(32);
const HEADERS = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android', 'X-RJ-Install': 'install-0001',
};
const PASSWORD = 'correct horse battery';

const ctx = {};

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_v1`;
  const other = `${base}_v1_other`;
  const admin = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), multipleStatements: true });
  for (const db of [name, other]) {
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await admin.query(`CREATE DATABASE \`${db}\``);
  }
  // A second database on the same server with an accolade column of its own: getUserAccolades must not see it
  // (the box holds rift_brain and rift_brain_dev side by side).
  await admin.query(`CREATE TABLE \`${other}\`.user_accolades (user_id INT UNSIGNED NOT NULL PRIMARY KEY, OtherDbOnly INT UNSIGNED DEFAULT 0)`);
  const conn = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: name, multipleStatements: true });
  await migrate(conn, { log: () => {} });
  await conn.end();
  ctx.admin = admin;
  ctx.dbs = [name, other];

  initDB({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: name });
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
  ctx.lobbies = createLobbyRegistry({ ports: [8100], serverBinary: '/bin/game', runCommand: async () => 1 });
  const app = createPublicApp(ctx.lobbies, { v1: { env: { ENV: 'dev', SESSION_KEY: KEY }, remote } });
  ctx.server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.lobbies.stop();
  ctx.server.close();
  await getDB().end();
  for (const db of ctx.dbs) await ctx.admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await ctx.admin.end();
});

async function call(method, path, { body, token, headers = HEADERS } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(ctx.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: JSON.parse(await r.text()) };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

async function q(sql, params = []) {
  const [rows] = await getDB().query(sql, params);
  return rows;
}

test('POST /v1/accounts makes the account, its four rows and a hashed credential, and signs it in', { skip }, async () => {
  const r = await call('POST', '/v1/accounts', { body: { username: 'Pilot_One', email: 'one@example.com', password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'ok');
  const d = r.body.data;
  assert.deepEqual(Object.keys(d).sort(), ['credential', 'session', 'user']);
  assert.deepEqual(Object.keys(d.user).sort(), ['id', 'username']);
  assert.equal(d.user.username, 'Pilot_One');
  assert.equal(d.session.expires_in, 3600);
  assert.equal(d.credential.user_id, d.user.id);
  assert.match(d.credential.token, /^[A-Za-z0-9_-]{43}$/);
  const s = verifySession(d.session.token, { keyHex: KEY, env: 'dev', nowSec: Math.floor(Date.now() / 1000) });
  assert.equal(s.ok, true);
  assert.equal(s.payload.uid, d.user.id);

  const creds = await q('SELECT * FROM user_credentials WHERE user_id = ?', [d.user.id]);
  assert.equal(creds.length, 1);
  assert.equal(creds[0].token_hash, sha256(d.credential.token), 'only SHA-256(token) is stored');
  assert.deepEqual([creds[0].platform, creds[0].install_id, creds[0].revoked_at], ['android', 'install-0001', null]);
  for (const t of ['user_stats', 'user_accolades', 'user_accolades_time_earned', 'user_player_card']) {
    assert.equal((await q(`SELECT user_id FROM ${t} WHERE user_id = ?`, [d.user.id])).length, 1, t);
  }
  const [u] = await q('SELECT password FROM users WHERE user_id = ?', [d.user.id]);
  assert.match(u.password, /^\$2[aby]\$10\$/, 'bcrypt');
  ctx.one = { id: d.user.id, credential: d.credential, session: d.session.token };
});

test('account rules answer VALIDATION with the server\'s message', { skip }, async () => {
  const taken = await call('POST', '/v1/accounts', { body: { username: 'Pilot_One', email: 'other@example.com', password: 'x' } });
  assert.equal(code(taken), 'VALIDATION');
  assert.equal(taken.body.error.message, 'This username "Pilot_One" is already taken.');
  assert.equal(code(await call('POST', '/v1/accounts', { body: { username: 'Two', email: 'one@example.com', password: 'x' } })), 'VALIDATION');
  assert.equal(code(await call('POST', '/v1/accounts', { body: { username: 'Two', email: 'nope', password: 'x' } })), 'VALIDATION');
  const missing = await call('POST', '/v1/accounts', { body: { username: 'Two', email: 'two@example.com' } });
  assert.deepEqual([code(missing), missing.body.error.message], ['VALIDATION', 'Missing required field: password']);
  assert.equal((await q("SELECT COUNT(*) AS n FROM users WHERE username = 'Two'"))[0].n, 0);
});

test('password login by username or email issues a new credential; a wrong password or name is AUTH_INVALID', { skip }, async () => {
  const byName = await call('POST', '/v1/session', { body: { login: { id: 'Pilot_One', password: PASSWORD } } });
  assert.equal(code(byName), 'ok');
  assert.deepEqual(Object.keys(byName.body.data).sort(), ['credential', 'session', 'user']);
  assert.deepEqual(byName.body.data.user, { id: ctx.one.id, username: 'Pilot_One' });
  const byEmail = await call('POST', '/v1/session', { headers: { ...HEADERS, 'X-RJ-Platform': 'ios', 'X-RJ-Install': 'install-0002' }, body: { login: { id: 'one@example.com', password: PASSWORD } } });
  assert.equal(code(byEmail), 'ok');
  assert.notEqual(byEmail.body.data.credential.token, byName.body.data.credential.token);
  assert.equal((await q('SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?', [ctx.one.id]))[0].n, 3, 'one per device');
  const wrong = await call('POST', '/v1/session', { body: { login: { id: 'Pilot_One', password: 'wrong' } } });
  assert.equal(code(wrong), 'AUTH_INVALID');
  assert.deepEqual([wrong.status, wrong.body.error.scope, wrong.body.error.action.kind], [401, 'account', 'login']);
  assert.equal(code(await call('POST', '/v1/session', { body: { login: { id: 'nobody', password: 'x' } } })), 'AUTH_INVALID');
});

test('credential restore issues a session (no credential), touches last_used_at; unknown or revoked is AUTH_INVALID', { skip }, async () => {
  await q('UPDATE user_credentials SET last_used_at = NULL WHERE token_hash = ?', [sha256(ctx.one.credential.token)]);
  const r = await call('POST', '/v1/session', { body: { credential: ctx.one.credential, session: ctx.one.session } });
  assert.equal(code(r), 'ok');
  assert.deepEqual(Object.keys(r.body.data).sort(), ['session', 'user']);
  assert.deepEqual(r.body.data.user, { id: ctx.one.id, username: 'Pilot_One' });
  const [c] = await q('SELECT last_used_at FROM user_credentials WHERE token_hash = ?', [sha256(ctx.one.credential.token)]);
  assert.ok(c.last_used_at !== null);

  const wrongUser = await call('POST', '/v1/session', { body: { credential: { user_id: ctx.one.id + 1, token: ctx.one.credential.token } } });
  assert.equal(code(wrongUser), 'AUTH_INVALID');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: { user_id: ctx.one.id, token: 'A'.repeat(43) } } })), 'AUTH_INVALID');
  const string = await call('POST', '/v1/session', { body: { credential: { user_id: String(ctx.one.id), token: ctx.one.credential.token } } });
  assert.equal(code(string), 'ok', 'a user id as a string of digits is read');

  const other = await call('POST', '/v1/session', { body: { login: { id: 'Pilot_One', password: PASSWORD } } });
  await q('UPDATE user_credentials SET revoked_at = NOW() WHERE token_hash = ?', [sha256(other.body.data.credential.token)]);
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: other.body.data.credential } })), 'AUTH_INVALID');
  assert.equal(code(r), 'ok', 'revoking one device leaves the others signed in');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: ctx.one.credential } })), 'ok');
});

test('a dev credential or session at another environment\'s brain is refused on its credentials (spec M8 drill)', { skip }, async () => {
  const alphaSession = signSession({ uid: ctx.one.id, env: 'alpha', nowSec: Math.floor(Date.now() / 1000), keyHex: '77'.repeat(32) }).token;
  assert.equal(code(await call('POST', '/v1/me/sp-stats/sync', { token: alphaSession, body: { stats: {} } })), 'AUTH_REQUIRED');
});

test('the single-player sync writes only sp_ and currency columns; the rest, injection included, is ignored', { skip }, async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = await call('POST', '/v1/me/sp-stats/sync', {
    token: ctx.one.session,
    body: { stats: {
      _last_updated: future,
      sp_most_jumps_in_a_run: 77,
      currency_amount: 1234,
      "sp_most_jumps_in_a_run = 1, mp_num_kills_alltime = 999 WHERE 1=1; -- ": 1,
      "sp_x = 1, password = 'x'": 1,
      mp_num_kills_alltime: 500,
      sp_does_not_exist: 3,
      user_id: 99,
    } },
  });
  assert.equal(code(r), 'ok');
  assert.deepEqual(Object.keys(r.body.data).sort(), ['ignored_keys', 'user_stats']);
  assert.deepEqual(r.body.data.ignored_keys.sort(), ["sp_most_jumps_in_a_run = 1, mp_num_kills_alltime = 999 WHERE 1=1; -- ", "sp_x = 1, password = 'x'",
    'mp_num_kills_alltime', 'sp_does_not_exist', 'user_id'].sort());
  assert.equal(r.body.data.user_stats.sp_most_jumps_in_a_run, 77);
  assert.equal(r.body.data.user_stats.currency_amount, 1234);
  assert.equal(r.body.data.user_stats.mp_num_kills_alltime, 0);
  assert.equal('user_id' in r.body.data.user_stats, false);
  assert.equal('_last_updated' in r.body.data.user_stats, false);
  const [u] = await q('SELECT password FROM users WHERE user_id = ?', [ctx.one.id]);
  assert.notEqual(u.password, 'x');

  const stale = await call('POST', '/v1/me/sp-stats/sync', { token: ctx.one.session, body: { stats: { _last_updated: 1000, sp_most_jumps_in_a_run: 1 } } });
  assert.equal(stale.body.data.user_stats.sp_most_jumps_in_a_run, 77, 'an older client copy does not win');
});

test('the accolade sync writes known accolades, stamps first earns, and ignores the rest', { skip }, async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = await call('POST', '/v1/me/accolades/sync', {
    token: ctx.one.session,
    body: { accolades: { _last_updated: future, Ghost: 2, 'Ghost = 0, Beaming': 5, OtherDbOnly: 1, Beaming: -3, Nope: 1 } },
  });
  assert.equal(code(r), 'ok');
  assert.deepEqual(Object.keys(r.body.data).sort(), ['ignored_keys', 'user_accolades']);
  assert.deepEqual(r.body.data.ignored_keys.sort(), ['Beaming', 'Ghost = 0, Beaming', 'Nope', 'OtherDbOnly']);
  assert.equal(r.body.data.user_accolades.Ghost.earned, 2);
  assert.ok(Number.isInteger(r.body.data.user_accolades.Ghost.timeFirstEarned));
  assert.equal(r.body.data.user_accolades.Beaming.earned, 0);
  assert.equal('OtherDbOnly' in r.body.data.user_accolades, false, 'another database\'s columns stay out (TABLE_SCHEMA)');
});

test('the player card equips an earned accolade, nothing for an unearned one, and reads back publicly', { skip }, async () => {
  assert.deepEqual((await call('PUT', '/v1/me/player-card', { token: ctx.one.session, body: { equipped_accolade_key: 'Ghost' } })).body,
    { result: 'ok', data: { equipped_accolade_key: 'Ghost' } });
  assert.deepEqual((await call('GET', `/v1/users/${ctx.one.id}/player-card`)).body,
    { result: 'ok', data: { user_id: ctx.one.id, equipped_accolade_key: 'Ghost' } });
  assert.equal((await call('PUT', '/v1/me/player-card', { token: ctx.one.session, body: { equipped_accolade_key: 'Beaming' } })).body.data.equipped_accolade_key, '');
  assert.equal((await call('PUT', '/v1/me/player-card', { token: ctx.one.session, body: { equipped_accolade_key: 'x` = 1 --' } })).body.data.equipped_accolade_key, '');
  assert.equal(code(await call('PUT', '/v1/me/player-card', { body: { equipped_accolade_key: 'Ghost' } })), 'AUTH_REQUIRED');
  assert.equal(code(await call('GET', '/v1/users/999999/player-card')), 'VALIDATION');
});

test('the public reads: a stats row, the accolades map, the columns and their labels', { skip }, async () => {
  const stats = await call('GET', `/v1/users/${ctx.one.id}/stats`);
  assert.equal(code(stats), 'ok');
  assert.equal(stats.body.data.user_id, ctx.one.id);
  assert.equal(stats.body.data.sp_most_jumps_in_a_run, 77);
  assert.equal('_last_updated' in stats.body.data, false);
  const missing = await call('GET', '/v1/users/999999/stats');
  assert.deepEqual([missing.status, code(missing)], [404, 'VALIDATION']);

  const acc = await call('GET', `/v1/users/${ctx.one.id}/accolades`);
  assert.equal(acc.body.data.Ghost.earned, 2);
  assert.deepEqual(Object.keys(acc.body.data.Ghost).sort(), ['earnRate', 'earned', 'timeFirstEarned']);

  const cols = await call('GET', '/v1/stats/columns');
  assert.ok(cols.body.data.columns.includes('sp_most_jumps_in_a_run'));
  assert.equal(cols.body.data.labels.sp_most_jumps_in_a_run, 'Most Jumps in a Run (Single Player)');
});

test('leaderboards: a known stat column only, the limit clamped to 1..100, the caller\'s rank', { skip }, async () => {
  for (let i = 0; i < 3; i++) {
    const a = await call('POST', '/v1/accounts', { headers: { ...HEADERS, 'X-RJ-Install': `lb-${i}` }, body: { username: `Ranker${i}`, email: `r${i}@example.com`, password: PASSWORD } });
    await q('UPDATE user_stats SET sp_most_jumps_in_a_run = ? WHERE user_id = ?', [100 - i * 10, a.body.data.user.id]);
  }
  const r = await call('GET', `/v1/leaderboards/sp_most_jumps_in_a_run?limit=2&user_id=${ctx.one.id}`);
  assert.equal(code(r), 'ok');
  assert.deepEqual(r.body.data.list.map((e) => [e.username, e.score, e.position, e.rank]), [['Ranker0', 100, 1, 1], ['Ranker1', 90, 2, 2]]);
  assert.deepEqual(r.body.data.user, { user_id: ctx.one.id, username: 'Pilot_One', score: 77, rank: 4 });
  assert.equal((await call('GET', '/v1/leaderboards/sp_most_jumps_in_a_run?limit=0')).body.data.list.length, 1);
  assert.equal((await call('GET', '/v1/leaderboards/sp_most_jumps_in_a_run?limit=100000')).body.data.list.length, 4);
  assert.equal((await call('GET', '/v1/leaderboards/sp_most_jumps_in_a_run?limit=abc')).body.data.list.length, 4);
  for (const bad of ['password', 'user_id', 'sp_x%20DESC%3B%20DROP%20TABLE%20users', '_last_updated']) {
    assert.equal(code(await call('GET', `/v1/leaderboards/${bad}`)), 'VALIDATION', bad);
  }
  assert.equal(code(await call('GET', '/v1/leaderboards/sp_most_jumps_in_a_run?user_id=x')), 'VALIDATION');
});

test('credential restores are rate limited per credential, from config', { skip }, async () => {
  ctx.view.server.rate_limits = { ...ctx.view.server.rate_limits, restore_per_min_credential: 2 };
  const login = await call('POST', '/v1/session', { body: { login: { id: 'Ranker2', password: PASSWORD } } });
  const cred = login.body.data.credential;
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: cred } })), 'ok');
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: cred } })), 'ok');
  const r = await call('POST', '/v1/session', { body: { credential: cred } });
  assert.equal(code(r), 'RATE_LIMITED');
  assert.equal(r.body.error.retry.kind, 'after');
  const other = (await call('POST', '/v1/session', { body: { login: { id: 'Ranker1', password: PASSWORD } } })).body.data.credential;
  assert.equal(code(await call('POST', '/v1/session', { body: { credential: other } })), 'ok', 'another credential');
});

test('the legacy syncs keep today\'s response shape, and drop the keys /v1 ignores', { skip }, async () => {
  const future = Math.floor(Date.now() / 1000) + 7200;
  const post = async (path, body) => {
    const r = await fetch(ctx.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const sp = await post('/single_player_stats_sync', { user_id: ctx.one.id, stats: { _last_updated: future, sp_most_jumps_in_a_run: 88, "sp_x = 1, password = 'x'": 1 } });
  assert.equal(sp.status, 200);
  assert.deepEqual(Object.keys(sp.body).sort(), ['data', 'message', 'success']);
  assert.deepEqual(Object.keys(sp.body.data).sort(), ['user_id', 'user_stats']);
  assert.equal(sp.body.data.user_stats.sp_most_jumps_in_a_run, 88);
  const acc = await post('/player_accolades_sync', { user_id: ctx.one.id, accolades: { _last_updated: future, Ghost: 3, 'Ghost = 9 --': 1 } });
  assert.deepEqual(Object.keys(acc.body.data).sort(), ['user_accolades', 'user_id']);
  assert.equal(acc.body.data.user_accolades.Ghost.earned, 3);
});

test('no password, credential token or session token reached the log', { skip }, () => {
  const text = ctx.lines.join('\n');
  assert.ok(ctx.lines.some((l) => l.startsWith('[v1] r-')), 'the request lines were captured (the measurement works)');
  assert.ok(!text.includes(PASSWORD));
  assert.ok(!text.includes(ctx.one.credential.token));
  assert.ok(!text.includes(ctx.one.session));
});
