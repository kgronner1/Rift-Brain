'use strict';
// M4 against a real database built from migrations/: /v1/match/join reads the player's name from `users`, and the
// internal API's results and accolades write only for players who took a seat. Runs only with RJ_TEST_DB set (see
// migrate.db.test.js); this file uses its own database, <name>_m4.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp, createInternalApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { signSession, verify } = require('../src/auth/tokens');
const { createAccount } = require('../src/storage/users');
const { SESSION_KEY, JOIN_KEY, LOBBY_MASTER_KEY, FP_A, ENV, makeRegistry, beat, lobbyKey, quietLogger } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const ctx = {};

const MATCH_STATS = {
  currencyDelta: 0, matchOutcome: 1, numJumps: 5, numHits: 0, numMisses: 0, numHitsReceived: 0, numKills: 0,
  numUniquePlayersKilled: 0, numDeaths: 0, numDeathsByOtherPlayers: 0, matchDurationSec: 60, timeSpentAliveSec: 60,
};

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_m4`;
  const conn = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...conn, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\``);
  const c = await mysql.createConnection({ ...conn, database: name, multipleStatements: true });
  await migrate(c, { log: () => {} });
  await c.end();
  ctx.admin = admin;
  ctx.name = name;
  initDB({ ...conn, database: name });

  ctx.restore = [];
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    console[m] = () => {};
    ctx.restore.push(() => { console[m] = orig; });
  }
  ctx.a = await createAccount({ username: 'seatedpilot', email: 'seated@example.test', password: 'password one' }, { platform: 'android', installId: 'i-a' });
  ctx.b = await createAccount({ username: 'ghostpilot', email: 'ghost@example.test', password: 'password two' }, { platform: 'android', installId: 'i-b' });

  ctx.m = makeRegistry({ logger: quietLogger() });
  const remote = createRemoteConfig({ env: 'dev', url: null, log: { info() {}, warn() {}, error() {} } });
  remote._set(ctx.m.view);
  const now = () => ctx.m.clock.t;
  ctx.pub = await listen(createPublicApp(null, { v1: { env: { ...ENV, SESSION_KEY }, remote, now, match: ctx.m.reg } }));
  ctx.int = await listen(createInternalApp({ env: { LOBBY_MASTER_KEY }, match: ctx.m.reg }));
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.pub.close();
  ctx.int.close();
  await getDB().end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.name}\``);
  await ctx.admin.end();
});

async function http(server, method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
  return { status: r.status, body: await r.json() };
}

function clientHeaders(uid, install) {
  const token = signSession({ uid, env: 'dev', nowSec: Math.floor(ctx.m.clock.t / 1000), keyHex: SESSION_KEY }).token;
  return {
    'X-RJ-Api': '1', 'X-RJ-Build': '1', 'X-RJ-Wire': '17', 'X-RJ-Wire-Fp': FP_A, 'X-RJ-Env': 'dev',
    'X-RJ-Platform': 'android', 'X-RJ-Install': install, Authorization: `Bearer ${token}`,
  };
}

async function stat(uid, col) {
  const [rows] = await getDB().execute(`SELECT ${col} AS v FROM user_stats WHERE user_id = ?`, [uid]);
  return rows[0].v;
}

test('join reads the username; results and accolades write only for the seated player', { skip }, async () => {
  const { reg } = ctx.m;
  const q = await http(ctx.pub, 'POST', '/v1/match/join', { headers: clientHeaders(ctx.a.user_id, 'i-a'), body: { mode: 'quickplay' } });
  assert.equal(q.body.result, 'queued');
  const lobby = [...reg.lobbies.values()][0];
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const ok = await http(ctx.pub, 'GET', `/v1/queue/${q.body.queued.ticket}`, { headers: clientHeaders(ctx.a.user_id, 'i-a') });
  const tok = verify(ok.body.data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(ctx.m.clock.t / 1000) });
  assert.equal(tok.payload.uname, 'seatedpilot');

  const lh = { 'X-RJ-Lobby': lobby.id, 'X-RJ-Lobby-Key': lobbyKey(lobby.id), 'X-RJ-Wire': '17' };
  assert.equal((await http(ctx.int, 'POST', '/internal/v1/lobby/player-joined', { headers: lh, body: { user_id: ctx.a.user_id, seat: tok.payload.seat } })).status, 200);

  const wonA = await stat(ctx.a.user_id, 'mp_num_matches_won_alltime');
  const wonB = await stat(ctx.b.user_id, 'mp_num_matches_won_alltime');
  const r = await http(ctx.int, 'POST', '/internal/v1/match/results', {
    headers: lh,
    body: [{ user_id: ctx.a.user_id, stats: MATCH_STATS }, { user_id: ctx.b.user_id, stats: MATCH_STATS }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.ignored_user_ids, [ctx.b.user_id]);
  assert.equal(r.body.data.players.length, 1);
  assert.equal(r.body.data.players[0].user_id, ctx.a.user_id);
  assert.equal(await stat(ctx.a.user_id, 'mp_num_matches_won_alltime'), wonA + 1);
  assert.equal(await stat(ctx.b.user_id, 'mp_num_matches_won_alltime'), wonB, 'an unseated player is untouched');

  const acc = await http(ctx.int, 'POST', '/internal/v1/match/accolades', { headers: lh, body: { user_id: ctx.b.user_id, accolades: {} } });
  assert.equal(acc.status, 403);
  const accOk = await http(ctx.int, 'POST', '/internal/v1/match/accolades', { headers: lh, body: { user_id: ctx.a.user_id, accolades: { _last_updated: 1 } } });
  assert.equal(accOk.body.result, 'ok', JSON.stringify(accOk.body));
  assert.ok('user_accolades' in accOk.body.data && 'ignored_keys' in accOk.body.data);

  const card = await http(ctx.int, 'GET', `/internal/v1/users/${ctx.a.user_id}/player-card`, { headers: lh });
  assert.deepEqual(card.body.data, { user_id: ctx.a.user_id, equipped_accolade_key: '' });
  const rates = await http(ctx.int, 'GET', '/internal/v1/users/0/accolades', { headers: lh });
  assert.equal(rates.body.result, 'ok');
});
