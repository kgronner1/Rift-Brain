'use strict';
// RJ 585, against a real database built from migrations/: 0010's three per-mode win columns, and
// /internal/v1/match/results counting a win toward the mode its entry names -- a STOCK win, a DOMINATION win, a TIME
// win, a loss, a draw, a report with no mode (a wire-13 game server's), a mode the brain does not know, a private
// lobby's report, and the answer carrying the new count of the match that reaches ten. Runs only with RJ_TEST_DB set
// (see migrate.db.test.js); this file uses its own database, <name>_rj585.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate, MIGRATIONS_DIR } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createInternalApp } = require('../src/app');
const { createAccount } = require('../src/storage/users');
const { LOBBY_MASTER_KEY, makeRegistry, player, beat, lobbyKey, quietLogger } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const MIGRATION = '0010_rj585_mode_wins.sql';
const STOCK = 'mp_num_stock_matches_won_alltime';
const DOMINATION = 'mp_num_domination_matches_won_alltime';
const TIME = 'mp_num_time_matches_won_alltime';
const WON = 'mp_num_matches_won_alltime';
const LOST = 'mp_num_matches_lost_alltime';
const DRAWN = 'mp_num_matches_drawed_alltime';
const COUNTS = [WON, STOCK, DOMINATION, TIME, LOST, DRAWN];
const ctx = {};

function stats(matchOutcome) {
  return {
    currencyDelta: 0, matchOutcome, numJumps: 5, numHits: 0, numMisses: 0, numHitsReceived: 0, numKills: 0,
    numUniquePlayersKilled: 0, numDeaths: 0, numDeathsByOtherPlayers: 0, matchDurationSec: 60, timeSpentAliveSec: 60,
  };
}

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_rj585`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\``);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  Object.assign(ctx, { conn: c, admin, name });
  initDB({ ...auth, database: name });

  // Everything before 0010 first, and an account made then: the row 0010 finds on a live database.
  ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj585-'));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (/^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < 10) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(ctx.dir, f));
  }
  await migrate(c, { dir: ctx.dir, log: () => {} });
  ctx.restore = [];
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    ctx.lines = ctx.lines || [];
    console[m] = (...a) => ctx.lines.push(a.join(' '));
    ctx.restore.push(() => { console[m] = orig; });
  }
  ctx.early = await createAccount({ username: 'earlypilot', email: 'early@example.test', password: 'password zero' }, { platform: 'android', installId: 'i-0' });
  const [[row]] = await c.query(`SELECT ${WON} AS won FROM user_stats WHERE user_id = ?`, [ctx.early.user_id]);
  ctx.earlyWon = row.won;
  const r = await migrate(c, { log: () => {} });
  assert.deepEqual(r.applied, [MIGRATION]);

  ctx.a = await createAccount({ username: 'stockpilot', email: 'a@example.test', password: 'password one' }, { platform: 'android', installId: 'i-a' });
  ctx.b = await createAccount({ username: 'hillpilot', email: 'b@example.test', password: 'password two' }, { platform: 'android', installId: 'i-b' });
  ctx.c = await createAccount({ username: 'privatepilot', email: 'c@example.test', password: 'password three' }, { platform: 'android', installId: 'i-c' });

  ctx.m = makeRegistry({ logger: quietLogger() });
  const app = createInternalApp({ env: { LOBBY_MASTER_KEY }, match: ctx.m.reg });
  ctx.int = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.int.close();
  await getDB().end();
  await ctx.conn.end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.name}\``);
  await ctx.admin.end();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

async function columns() {
  const [rows] = await ctx.conn.query(
    `SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, ORDINAL_POSITION AS p
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_stats' ORDER BY ORDINAL_POSITION`);
  return rows;
}

async function counts(uid) {
  const [[row]] = await ctx.conn.query(`SELECT ${COUNTS.join(', ')} FROM user_stats WHERE user_id = ?`, [uid]);
  return COUNTS.map((c) => Number(row[c]));
}

// [won, stock, domination, time, lost, drawn] after - before.
function delta(before, after) {
  return after.map((v, i) => v - before[i]);
}

// Seats each of `uids` in a lobby, as a game server's player-joined seats them: quickplay's lobby, or with `private`
// a new private lobby made by the first. Answers the lobby.
async function seatedLobby(uids, { private: priv = false } = {}) {
  const { reg } = ctx.m;
  let lobby = null;
  for (const uid of uids) {
    const p = player({ uid, uname: `pilot${uid}`, install: `install-${uid}` });
    if (priv && !lobby) p.mode = 'create_private';
    else if (lobby && lobby.privateCode) Object.assign(p, { mode: 'join_private', code: lobby.privateCode });
    const r = await reg.join(p);
    for (const l of reg.lobbies.values()) if (l.state === 'BOOTING') await reg.heartbeat(l.id, beat(l, 'PREGAME'));
    if (r.result === 'queued') await reg.poll(r.queued.ticket, p.install);
    lobby = [...reg.lobbies.values()].find((l) => [...l.seats.values()].some((x) => x.uid === uid));
    assert.ok(lobby, `user ${uid} was given a seat: ${JSON.stringify(r)}`);
    const seat = [...lobby.seats].find(([, s]) => s.uid === uid)[0];
    assert.equal((await reg.playerJoined(lobby.id, { user_id: uid, seat })).result, 'ok');
  }
  return lobby;
}

async function report(lobby, body) {
  const r = await fetch(`http://127.0.0.1:${ctx.int.address().port}/internal/v1/match/results`, {
    method: 'POST',
    headers: { 'X-RJ-Lobby': lobby.id, 'X-RJ-Lobby-Key': lobbyKey(lobby.id), 'X-RJ-Wire': '17', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  assert.equal(json.result, 'ok', JSON.stringify(json));
  return json.data;
}

function answered(data, uid, col) {
  const p = data.players.find((x) => x.user_id === uid);
  return p && p.stats[col] ? p.stats[col].value : undefined;
}

test('0010 adds the three per-mode win columns after the overall count, 0 on rows already there; a second run changes nothing', { skip }, async () => {
  const cols = await columns();
  const at = (name) => cols.findIndex((r) => r.c === name);
  assert.deepEqual([at(STOCK), at(DOMINATION), at(TIME)], [at(WON) + 1, at(WON) + 2, at(WON) + 3], 'beside mp_num_matches_won_alltime, in order');
  for (const name of [STOCK, DOMINATION, TIME]) {
    const r = cols[at(name)];
    assert.equal(r.t, 'int(11)', name);
    assert.equal(r.n, 'NO', name);
    assert.equal(String(r.d), '0', name);
  }
  assert.deepEqual(await counts(ctx.early.user_id), [ctx.earlyWon, 0, 0, 0, 0, 0].map(Number), 'an account made before 0010 reads 0 in each');
  assert.deepEqual((await counts(ctx.a.user_id)).slice(1, 4), [0, 0, 0], 'a new account starts at 0');

  await ctx.conn.query(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8'));
  assert.deepEqual((await columns()).map((r) => r.c), cols.map((r) => r.c));
});

test('a win counts toward the mode its entry names; a loss, a draw, no mode and an unknown mode count toward none', { skip }, async () => {
  const a = ctx.a.user_id;
  const b = ctx.b.user_id;
  const lobby = await seatedLobby([a, b]);
  ctx.lobby = lobby;

  let a0 = await counts(a);
  let b0 = await counts(b);
  let d = await report(lobby, [{ user_id: a, stats: stats(1), mode: 'stock' }, { user_id: b, stats: stats(-1), mode: 'stock' }]);
  assert.deepEqual(delta(a0, await counts(a)), [1, 1, 0, 0, 0, 0], 'a STOCK win');
  assert.deepEqual(delta(b0, await counts(b)), [0, 0, 0, 0, 1, 0], 'a STOCK loss');
  assert.equal(answered(d, a, STOCK), a0[1] + 1, 'the answer carries the count the database now holds');
  assert.equal(answered(d, b, STOCK), b0[1]);

  a0 = await counts(a);
  b0 = await counts(b);
  d = await report(lobby, [{ user_id: a, stats: stats(-1), mode: 'domination' }, { user_id: b, stats: stats(1), mode: 'domination' }]);
  assert.deepEqual(delta(b0, await counts(b)), [1, 0, 1, 0, 0, 0], 'a DOMINATION win');
  assert.deepEqual(delta(a0, await counts(a)), [0, 0, 0, 0, 1, 0], 'a DOMINATION loss');
  assert.equal(answered(d, b, DOMINATION), b0[2] + 1);

  a0 = await counts(a);
  b0 = await counts(b);
  await report(lobby, [{ user_id: a, stats: stats(1), mode: 'time' }, { user_id: b, stats: stats(-1), mode: 'time' }]);
  assert.deepEqual(delta(a0, await counts(a)), [1, 0, 0, 1, 0, 0], 'a TIME win');

  a0 = await counts(a);
  b0 = await counts(b);
  await report(lobby, [{ user_id: a, stats: stats(0), mode: 'domination' }, { user_id: b, stats: stats(0), mode: 'domination' }]);
  assert.deepEqual(delta(a0, await counts(a)), [0, 0, 0, 0, 0, 1], 'a draw (a tie for 1st) counts toward no mode');
  assert.deepEqual(delta(b0, await counts(b)), [0, 0, 0, 0, 0, 1]);

  a0 = await counts(a);
  b0 = await counts(b);
  d = await report(lobby, [{ user_id: a, stats: stats(1) }, { user_id: b, stats: stats(-1) }]);
  assert.deepEqual(delta(a0, await counts(a)), [1, 0, 0, 0, 0, 0], 'a wire-13 report (no mode): the win counts, toward no mode');
  assert.deepEqual(delta(b0, await counts(b)), [0, 0, 0, 0, 1, 0]);
  assert.equal(answered(d, a, STOCK), a0[1], 'and its answer still carries the per-mode counts');

  a0 = await counts(a);
  await report(lobby, [{ user_id: a, stats: stats(1), mode: 'ctf' }, { user_id: b, stats: stats(-1), mode: 'ctf' }]);
  assert.deepEqual(delta(a0, await counts(a)), [1, 0, 0, 0, 0, 0], 'a mode the brain does not know counts toward none');
  a0 = await counts(a);
  await report(lobby, [{ user_id: a, stats: stats(1), mode: 'STOCK' }]);
  assert.deepEqual(delta(a0, await counts(a)), [1, 0, 0, 0, 0, 0], 'nor does an on-screen label');
});

test('the match that reaches ten answers ten: the lifetime accolades read this report (RJ 567)', { skip }, async () => {
  const b = ctx.b.user_id;
  await ctx.conn.query(`UPDATE user_stats SET ${DOMINATION} = 9 WHERE user_id = ?`, [b]);
  const d = await report(ctx.lobby, [{ user_id: b, stats: stats(1), mode: 'domination' }]);
  assert.deepEqual(d.players.find((p) => p.user_id === b).stats[DOMINATION], { value: 10, new_record: 0 });
  assert.equal((await counts(b))[2], 10);
});

test('a private lobby\'s report writes nothing, a seated winner\'s included (RJ 498)', { skip }, async () => {
  const c = ctx.c.user_id;
  const lobby = await seatedLobby([c], { private: true });
  assert.ok(lobby.privateCode, 'the lobby is private');
  assert.equal(ctx.m.reg.verifiedSeat(lobby.id, c), true, 'the measurement: the player holds a verified seat');
  const before = await counts(c);
  const [[row0]] = await ctx.conn.query('SELECT num_jumps_alltime AS j FROM user_stats WHERE user_id = ?', [c]);
  const d = await report(lobby, [{ user_id: c, stats: stats(1), mode: 'stock' }]);
  assert.deepEqual(d, { players: [], ignored_user_ids: [c] });
  assert.deepEqual(await counts(c), before);
  const [[row1]] = await ctx.conn.query('SELECT num_jumps_alltime AS j FROM user_stats WHERE user_id = ?', [c]);
  assert.equal(row1.j, row0.j, 'no stat at all');

  // The same player and report from a public lobby: counted (the private check is what kept it out).
  const open = await seatedLobby([c]);
  await report(open, [{ user_id: c, stats: stats(1), mode: 'stock' }]);
  assert.deepEqual(delta(before, await counts(c)), [1, 1, 0, 0, 0, 0]);
  assert.ok(ctx.lines.some((l) => l.includes(`[match] lobby ${lobby.id}: results from a private lobby ignored`)), ctx.lines.join('\n'));
  assert.ok(ctx.lines.some((l) => l.includes(`[match] lobby ${open.id}: results for 1 seated player(s), mode stock`)), ctx.lines.join('\n'));
});
