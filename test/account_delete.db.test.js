'use strict';
// RJ 473, the account's hard delete, against a real database built from migrations/: DELETE /v1/me removes every
// per-user row in one transaction and anonymises the account's feedback, the match registry drops its reservation,
// and nothing brings the account back: the /me writes with a still-valid session, the internal API's results and
// accolades, another device's credential, the public reads and the leaderboards. Runs only with RJ_TEST_DB set (see
// migrate.db.test.js); this file uses its own database, <name>_delete.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp, createInternalApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { signSession, verify } = require('../src/auth/tokens');
const { deleteUser } = require('../src/storage');
const { insertFeedback } = require('../src/storage/feedback');
const { SESSION_KEY, JOIN_KEY, LOBBY_MASTER_KEY, FP_A, ENV, makeRegistry, beat, lobbyKey, quietLogger } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const PASSWORD = 'doomed pilot password';
const TABLES = ['users', 'user_credentials', 'user_player_card', 'user_accolades_time_earned', 'user_accolades', 'user_stats'];
const MATCH_STATS = {
  currencyDelta: 0, matchOutcome: 1, numJumps: 5, numHits: 0, numMisses: 0, numHitsReceived: 0, numKills: 0,
  numUniquePlayersKilled: 0, numDeaths: 0, numDeathsByOtherPlayers: 0, matchDurationSec: 60, timeSpentAliveSec: 60,
};
const ctx = {};
let seq = 0;
const uuid = () => `22222222-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

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
  const name = `${base}_delete`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  await migrate(c, { log: () => {} });
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
  ctx.m.view.server.rate_limits = { ...ctx.m.view.server.rate_limits, login_per_min_ip: 1000 };
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

function headers(install, { token, uid } = {}) {
  const h = {
    'X-RJ-Api': '1', 'X-RJ-Build': '1', 'X-RJ-Wire': '17', 'X-RJ-Wire-Fp': FP_A, 'X-RJ-Env': 'dev',
    'X-RJ-Platform': 'android', 'X-RJ-Install': install,
  };
  const bearer = token || (uid ? signSession({ uid, env: 'dev', nowSec: Math.floor(ctx.m.clock.t / 1000), keyHex: SESSION_KEY }).token : null);
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

async function http(server, method, path, { headers: h = {}, body } = {}) {
  const init = { method, headers: { ...h } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
  return { status: r.status, body: await r.json() };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

async function q(sql, params = []) {
  const [rows] = await getDB().query(sql, params);
  return rows;
}

// table -> how many rows the user has in it.
async function rowsOf(uid) {
  const out = {};
  for (const t of TABLES) out[t] = Number((await q(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [uid]))[0].n);
  return out;
}

const ALL_ROWS = (credentials) => ({
  users: 1, user_credentials: credentials, user_player_card: 1, user_accolades_time_earned: 1, user_accolades: 1, user_stats: 1,
});
const NO_ROWS = Object.fromEntries(TABLES.map((t) => [t, 0]));

async function signUp(username, install) {
  const r = await http(ctx.pub, 'POST', '/v1/accounts', {
    headers: headers(install), body: { username, email: `${username.toLowerCase()}@example.test`, password: PASSWORD },
  });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return { id: r.body.data.user.id, username, install, session: r.body.data.session.token, credential: r.body.data.credential };
}

// A player joins quickplay and takes the seat its token reserved (player-joined), as the game server reports.
async function seat(p) {
  const { reg } = ctx.m;
  let r = await http(ctx.pub, 'POST', '/v1/match/join', { headers: headers(p.install, { token: p.session }), body: { mode: 'quickplay' } });
  const lobby = [...reg.lobbies.values()][0];
  if (r.body.result === 'queued') {
    if (lobby.state === 'BOOTING') await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
    r = await http(ctx.pub, 'GET', `/v1/queue/${r.body.queued.ticket}`, { headers: headers(p.install, { token: p.session }) });
  }
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  const tok = verify(r.body.data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(ctx.m.clock.t / 1000) });
  ctx.lh = { 'X-RJ-Lobby': lobby.id, 'X-RJ-Lobby-Key': lobbyKey(lobby.id), 'X-RJ-Wire': '17' };
  const joined = await http(ctx.int, 'POST', '/internal/v1/lobby/player-joined', { headers: ctx.lh, body: { user_id: p.id, seat: tok.payload.seat } });
  assert.equal(joined.status, 200);
  return { lobby, seat: tok.payload.seat };
}

test('setup: a doomed account with data everywhere, a second device, feedback, a match seat and a reservation', { skip }, async () => {
  ctx.doomed = await signUp('Doomed_Pilot', '6f1c2b8e-0000-4000-8000-0000000000d1');
  ctx.other = await signUp('Bystander', '6f1c2b8e-0000-4000-8000-0000000000b1');
  const d = ctx.doomed;
  const login = await http(ctx.pub, 'POST', '/v1/session', {
    headers: { ...headers('6f1c2b8e-0000-4000-8000-0000000000d2'), 'X-RJ-Platform': 'ios' },
    body: { login: { id: 'doomed_pilot@example.test', password: PASSWORD } },
  });
  assert.equal(code(login), 'ok');
  d.secondDevice = login.body.data.credential;

  const future = Math.floor(Date.now() / 1000) + 3600;
  const me = headers(d.install, { token: d.session });
  assert.equal(code(await http(ctx.pub, 'POST', '/v1/me/sp-stats/sync', { headers: me, body: { stats: { _last_updated: future, sp_most_jumps_in_a_run: 999 } } })), 'ok');
  assert.equal(code(await http(ctx.pub, 'POST', '/v1/me/accolades/sync', { headers: me, body: { accolades: { _last_updated: future, Ghost: 3 } } })), 'ok');
  assert.equal((await http(ctx.pub, 'PUT', '/v1/me/player-card', { headers: me, body: { equipped_accolade_key: 'Ghost' } })).body.data.equipped_accolade_key, 'Ghost');
  await q('UPDATE user_stats SET sp_most_jumps_in_a_run = 10 WHERE user_id = ?', [ctx.other.id]);

  // Feedback: one sent through the route (pending), one the sheet already holds (sent), and the bystander's.
  ctx.fbPending = uuid();
  const fb = await http(ctx.pub, 'POST', '/v1/feedback', { headers: me, body: { id: ctx.fbPending, message: 'from the doomed pilot' } });
  assert.equal(code(fb), 'ok');
  assert.deepEqual((await q('SELECT user_id, username, install_id FROM feedback WHERE id = ?', [ctx.fbPending]))[0],
    { user_id: d.id, username: 'Doomed_Pilot', install_id: d.install });
  ctx.fbSent = uuid();
  ctx.fbOther = uuid();
  const row = (id, who) => ({
    id, received_ms: ctx.m.clock.t, written_at: null, user_id: who.id, username: who.username,
    install_id: who.install, ip: '203.0.113.9', build: 1, platform: 'android', env: 'dev', tags: [], message: 'x', context: {},
  });
  await insertFeedback(row(ctx.fbSent, d));
  await q("UPDATE feedback SET sheet_state = 'sent', sheet_sent_at = NOW(3) WHERE id = ?", [ctx.fbSent]);
  await insertFeedback(row(ctx.fbOther, ctx.other));

  // Both take seats in one lobby; then the doomed player joins again and holds a reservation beside that seat.
  ctx.doomedSeat = await seat(d);
  ctx.otherSeat = await seat(ctx.other);
  const again = await http(ctx.pub, 'POST', '/v1/match/join', { headers: headers(d.install, { token: d.session }), body: { mode: 'quickplay' } });
  assert.equal(code(again), 'ok');
  const mine = [...ctx.doomedSeat.lobby.seats.values()].filter((s) => s.uid === d.id).map((s) => s.status).sort();
  assert.deepEqual(mine, ['reserved', 'seated']);

  assert.deepEqual(await rowsOf(d.id), ALL_ROWS(2));
  const board = await http(ctx.pub, 'GET', '/v1/leaderboards/sp_most_jumps_in_a_run?limit=5', { headers: headers(d.install) });
  assert.equal(board.body.data.list[0].user_id, d.id, 'the doomed pilot leads the board before the delete (the measurement works)');
});

test('a wrong password changes nothing and says so; a missing one is VALIDATION', { skip }, async () => {
  const d = ctx.doomed;
  const wrong = await http(ctx.pub, 'DELETE', '/v1/me', { headers: headers(d.install, { token: d.session }), body: { password: 'not it' } });
  assert.deepEqual([code(wrong), wrong.status, wrong.body.error.message], ['AUTH_INVALID', 401, "That password isn't right."]);
  const missing = await http(ctx.pub, 'DELETE', '/v1/me', { headers: headers(d.install, { token: d.session }), body: {} });
  assert.equal(code(missing), 'VALIDATION');
  assert.deepEqual(await rowsOf(d.id), ALL_ROWS(2));
  assert.equal(ctx.lines.some((l) => l.startsWith('[account]')), false);
});

test('DELETE /v1/me: every per-user row gone in one go, the feedback anonymised, the reservation released', { skip }, async () => {
  const d = ctx.doomed;
  const otherBefore = await rowsOf(ctx.other.id);
  const r = await http(ctx.pub, 'DELETE', '/v1/me', { headers: headers(d.install, { token: d.session }), body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'ok', data: {} });

  assert.deepEqual(await rowsOf(d.id), NO_ROWS);
  assert.deepEqual(await rowsOf(ctx.other.id), otherBefore, 'nobody else\'s rows');

  const fb = Object.fromEntries((await q('SELECT * FROM feedback')).map((x) => [x.id, x]));
  for (const id of [ctx.fbPending, ctx.fbSent]) {
    const x = fb[id];
    assert.deepEqual([x.user_id, x.username, x.install_id, x.ip], [null, null, null, null], id);
    assert.ok(x.anonymized_at !== null);
    assert.ok(x.message.length > 0, 'the feedback itself is kept');
  }
  assert.equal(fb[ctx.fbPending].sheet_state, 'pending', 'it reaches the sheet already anonymous');
  assert.equal(fb[ctx.fbSent].sheet_state, 'anon_pending', 'the sheet\'s Player cell is rewritten');
  assert.deepEqual([fb[ctx.fbOther].user_id, fb[ctx.fbOther].username, fb[ctx.fbOther].anonymized_at], [ctx.other.id, 'Bystander', null]);

  const mine = [...ctx.doomedSeat.lobby.seats.values()].filter((s) => s.uid === d.id).map((s) => s.status);
  assert.deepEqual(mine, ['seated'], 'the reservation went; the taken seat plays on');

  assert.deepEqual(ctx.lines.filter((l) => l.startsWith('[account]')), [`[account] user ${d.id} deleted`]);
  const text = ctx.lines.join('\n');
  for (const secret of [PASSWORD, 'Doomed_Pilot', 'doomed_pilot@example.test', d.session, d.credential.token]) {
    assert.ok(!text.includes(secret), `the log holds ${secret}`);
  }
});

test('a still-valid session writes nothing: the /me syncs, the player card, a join and a second delete', { skip }, async () => {
  const d = ctx.doomed;
  const me = headers(d.install, { token: d.session });
  const future = Math.floor(Date.now() / 1000) + 7200;
  const writes = [
    ['POST', '/v1/me/sp-stats/sync', { stats: { _last_updated: future, sp_most_jumps_in_a_run: 1 } }],
    ['POST', '/v1/me/accolades/sync', { accolades: { _last_updated: future, Ghost: 5 } }],
    ['PUT', '/v1/me/player-card', { equipped_accolade_key: 'Ghost' }],
    ['POST', '/v1/match/join', { mode: 'quickplay' }],
  ];
  for (const [method, path, body] of writes) {
    const r = await http(ctx.pub, method, path, { headers: me, body });
    assert.deepEqual([code(r), r.body.error.scope], ['AUTH_INVALID', 'account'], path);
  }
  const again = await http(ctx.pub, 'DELETE', '/v1/me', { headers: me, body: { password: PASSWORD } });
  assert.deepEqual([code(again), again.body.error.message], ['AUTH_INVALID', "That username, email or password isn't right."]);
  assert.deepEqual(await rowsOf(d.id), NO_ROWS);
  assert.equal([...ctx.doomedSeat.lobby.seats.values()].filter((s) => s.uid === d.id).length, 1, 'the join reserved nothing');

  // Feedback is not an account write: a stale session's note is stored, as anonymous.
  const id = uuid();
  assert.equal(code(await http(ctx.pub, 'POST', '/v1/feedback', { headers: me, body: { id, message: 'after' } })), 'ok');
  assert.deepEqual((await q('SELECT user_id, username FROM feedback WHERE id = ?', [id]))[0], { user_id: null, username: null });
});

test('every device\'s credential, and the password, are refused: AUTH_INVALID, scope account', { skip }, async () => {
  const d = ctx.doomed;
  for (const credential of [d.credential, d.secondDevice]) {
    const r = await http(ctx.pub, 'POST', '/v1/session', { headers: headers(d.install), body: { credential } });
    assert.deepEqual([code(r), r.body.error.scope, r.body.error.action.kind], ['AUTH_INVALID', 'account', 'login']);
  }
  const login = await http(ctx.pub, 'POST', '/v1/session', { headers: headers(d.install), body: { login: { id: 'Doomed_Pilot', password: PASSWORD } } });
  assert.equal(code(login), 'AUTH_INVALID');
});

test('the internal API ignores the deleted player\'s results and accolades and recreates no row', { skip }, async () => {
  const d = ctx.doomed;
  const wonBefore = (await q('SELECT mp_num_matches_won_alltime AS n FROM user_stats WHERE user_id = ?', [ctx.other.id]))[0].n;
  const r = await http(ctx.int, 'POST', '/internal/v1/match/results', {
    headers: ctx.lh, body: [{ user_id: d.id, stats: MATCH_STATS }, { user_id: ctx.other.id, stats: MATCH_STATS }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.ignored_user_ids, [d.id]);
  assert.deepEqual(r.body.data.players.map((p) => p.user_id), [ctx.other.id]);
  assert.equal((await q('SELECT mp_num_matches_won_alltime AS n FROM user_stats WHERE user_id = ?', [ctx.other.id]))[0].n, wonBefore + 1,
    'the rest of the match still counts');

  const acc = await http(ctx.int, 'POST', '/internal/v1/match/accolades', { headers: ctx.lh, body: { user_id: d.id, accolades: { _last_updated: 9, Ghost: 4 } } });
  assert.equal(acc.status, 200);
  assert.deepEqual(acc.body.data, { user_accolades: {}, ignored_keys: ['Ghost'] });
  const accOther = await http(ctx.int, 'POST', '/internal/v1/match/accolades', { headers: ctx.lh, body: { user_id: ctx.other.id, accolades: { _last_updated: 9 } } });
  assert.ok('Ghost' in accOther.body.data.user_accolades, 'a live player\'s accolades still answer the full map');
  assert.deepEqual(await rowsOf(d.id), NO_ROWS);
});

test('the public reads answer for the deleted id exactly as for an id that never existed; leaderboards drop it', { skip }, async () => {
  const d = ctx.doomed;
  const [[{ max }]] = await getDB().query('SELECT MAX(user_id) AS max FROM users');
  const never = Number(max) + 1000;
  const strip = (r) => (r.body.result === 'error' ? { status: r.status, ...r.body.error, ref: '' } : { status: r.status, ...r.body });
  const h = { headers: headers(ctx.other.install) };
  for (const path of ['stats', 'player-card', 'accolades']) {
    const gone = await http(ctx.pub, 'GET', `/v1/users/${d.id}/${path}`, h);
    const unknown = await http(ctx.pub, 'GET', `/v1/users/${never}/${path}`, h);
    assert.deepEqual(strip(gone), strip(unknown), path);
    const live = await http(ctx.pub, 'GET', `/v1/users/${ctx.other.id}/${path}`, h);
    assert.equal(code(live), 'ok', `${path}: a live id reads ok (the comparison means something)`);
  }
  const stats = await http(ctx.pub, 'GET', `/v1/users/${d.id}/stats`, h);
  assert.deepEqual([stats.status, code(stats), stats.body.error.message], [404, 'VALIDATION', "That player doesn't exist."]);
  const acc = await http(ctx.pub, 'GET', `/v1/users/${d.id}/accolades`, h);
  assert.equal(acc.body.data.Ghost.earned, 0, 'an unknown id reads as nobody: nothing earned');
  const gone = await http(ctx.int, 'GET', `/internal/v1/users/${d.id}/player-card`, { headers: ctx.lh });
  assert.equal(gone.status, 404);

  const board = await http(ctx.pub, 'GET', `/v1/leaderboards/sp_most_jumps_in_a_run?limit=100&user_id=${d.id}`, h);
  assert.equal(code(board), 'ok');
  assert.equal(board.body.data.list.some((e) => e.user_id === d.id), false);
  assert.equal(board.body.data.list[0].user_id, ctx.other.id);
  assert.equal(board.body.data.user, null);
});

test('the name and email are free again: a new account takes them, with a new id', { skip }, async () => {
  const again = await signUp('Doomed_Pilot', '6f1c2b8e-0000-4000-8000-0000000000d3');
  assert.notEqual(again.id, ctx.doomed.id);
  const stale = await http(ctx.pub, 'POST', '/v1/me/sp-stats/sync', { headers: headers(ctx.doomed.install, { token: ctx.doomed.session }), body: { stats: {} } });
  assert.equal(code(stale), 'AUTH_INVALID', 'the old session names the old id, not the new account');
  ctx.reborn = again;
});

test('deleteUser: one transaction (a failure part way leaves every row), false for no such user', { skip }, async () => {
  const victim = ctx.reborn;
  await insertFeedback({
    id: uuid(), received_ms: ctx.m.clock.t, written_at: null, user_id: victim.id, username: victim.username, install_id: null,
    ip: null, build: 1, platform: 'android', env: 'dev', tags: [], message: 'kept', context: {},
  });
  const pool = getDB();
  // The feedback step is last: when it fails, the deletes before it must roll back.
  const failing = {
    async getConnection() {
      const c = await pool.getConnection();
      return new Proxy(c, {
        get(target, key) {
          if (key === 'execute') {
            return (sql, params) => (/^\s*UPDATE feedback/.test(sql) ? Promise.reject(new Error('feedback write failed')) : target.execute(sql, params));
          }
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
  await assert.rejects(deleteUser(victim.id, { db: failing }), /feedback write failed/);
  assert.deepEqual(await rowsOf(victim.id), ALL_ROWS(1));
  assert.equal((await q('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?', [victim.id]))[0].n, 1);
  const restore = await http(ctx.pub, 'POST', '/v1/session', { headers: headers(victim.install), body: { credential: victim.credential } });
  assert.equal(code(restore), 'ok', 'the account still signs in');

  // Outside a request (M2's guest cull calls it this way).
  assert.equal(await deleteUser(victim.id), true);
  assert.deepEqual(await rowsOf(victim.id), NO_ROWS);
  assert.equal((await q('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?', [victim.id]))[0].n, 0);
  assert.equal(await deleteUser(victim.id), false);
  assert.equal(await deleteUser(2147483647), false);
  const hash = crypto.createHash('sha256').update(victim.credential.token).digest('hex');
  assert.equal((await q('SELECT COUNT(*) AS n FROM user_credentials WHERE token_hash = ?', [hash]))[0].n, 0);
});
