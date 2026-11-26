'use strict';
// RJ 585 M3, against a real database built from migrations/: 0011's three accolade columns (Gloves Off, Wolves at Bay,
// Who's House?) in both accolade tables, a second run changing nothing, and a game server's path end to end through the
// internal API -- a DOMINATION match's results carrying Who's House?'s hill takes (which the brain never reads), the
// accolades recorded with their first-earned time, and the next match's read of them. Runs only with RJ_TEST_DB set
// (see migrate.db.test.js); this file uses its own database, <name>_rj585acc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrate, MIGRATIONS_DIR } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createInternalApp } = require('../src/app');
const { createAccount } = require('../src/storage/users');
const { LOBBY_MASTER_KEY, makeRegistry, player, beat, lobbyKey, quietLogger } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const MIGRATION = '0011_rj585_accolades.sql';
const ACCOLADES = ['GlovesOff', 'WolvesatBay', 'WhosHouse'];
const ctx = {};

function stats(matchOutcome, extra = {}) {
  return {
    currencyDelta: 0, matchOutcome, numJumps: 5, numHits: 0, numMisses: 0, numHitsReceived: 0, numKills: 0,
    numUniquePlayersKilled: 0, numDeaths: 0, numDeathsByOtherPlayers: 0, matchDurationSec: 60, timeSpentAliveSec: 60,
    ...extra,
  };
}

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_rj585acc`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  const r = await migrate(c, { log: () => {} });
  assert.ok(r.applied.includes(MIGRATION), r.applied.join(', '));
  Object.assign(ctx, { conn: c, admin, name });
  initDB({ ...auth, database: name });
  ctx.m = makeRegistry({ logger: quietLogger() });
  const app = createInternalApp({ env: { LOBBY_MASTER_KEY }, match: ctx.m.reg });
  ctx.int = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  ctx.restore = [];
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    console[m] = () => {};
    ctx.restore.push(() => { console[m] = orig; });
  }
});

test.after(async () => {
  if (skip) return;
  for (const r of ctx.restore) r();
  ctx.int.close();
  await getDB().end();
  await ctx.conn.end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.name}\``);
  await ctx.admin.end();
});

async function columns(table) {
  const [rows] = await ctx.conn.query(
    'SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]);
  return Object.fromEntries(rows.map((r) => [r.c, r]));
}

// Seats each of `uids` in quickplay's lobby, as a game server's player-joined seats them. Answers the lobby.
async function seatedLobby(uids) {
  const { reg } = ctx.m;
  let lobby = null;
  for (const uid of uids) {
    const p = player({ uid, uname: `pilot${uid}`, install: `install-${uid}` });
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

async function internal(lobby, method, route, body) {
  const r = await fetch(`http://127.0.0.1:${ctx.int.address().port}/internal/v1${route}`, {
    method,
    headers: { 'X-RJ-Lobby': lobby.id, 'X-RJ-Lobby-Key': lobbyKey(lobby.id), 'X-RJ-Wire': '17', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  assert.equal(json.result, 'ok', JSON.stringify(json));
  return json.data;
}

test('0011 adds the three accolades to both tables, and a second run changes nothing', { skip }, async () => {
  const counts = await columns('user_accolades');
  const times = await columns('user_accolades_time_earned');
  for (const key of ACCOLADES) {
    assert.ok(counts[key], `user_accolades.${key}`);
    assert.match(counts[key].t, /^int\(10\) unsigned$/, key);
    assert.equal(counts[key].n, 'NO', key);
    assert.equal(String(counts[key].d), '0', key);
    assert.ok(times[key], `user_accolades_time_earned.${key}`);
    assert.equal(times[key].t, 'timestamp', key);
    assert.equal(times[key].n, 'YES', key);
  }
  const before = [Object.keys(counts).length, Object.keys(times).length];
  await ctx.conn.query(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8'));
  assert.deepEqual([Object.keys(await columns('user_accolades')).length, Object.keys(await columns('user_accolades_time_earned')).length], before);
});

test('a game server records them: results with the hill takes, the accolades with their first time, the next read', { skip }, async () => {
  const a = await createAccount({ username: 'hillholder', email: 'hill@example.test', password: 'a real pilot password' },
    { platform: 'android', installId: '6f1c2b8e-0000-4000-8585-000000000001' });
  const b = await createAccount({ username: 'hilltaker', email: 'taker@example.test', password: 'another pilot password' },
    { platform: 'android', installId: '6f1c2b8e-0000-4000-8585-000000000002' });
  const lobby = await seatedLobby([a.user_id, b.user_id]);
  const fresh = await internal(lobby, 'GET', `/users/${a.user_id}/accolades`);
  for (const key of ACCOLADES) assert.deepEqual([fresh[key].earned, fresh[key].timeFirstEarned], [0, null], key);

  // The 10th DOMINATION win, its stats carrying Who's House?'s hill takes: the brain counts the win and keeps no take.
  await ctx.conn.query('UPDATE user_stats SET mp_num_domination_matches_won_alltime = 9 WHERE user_id = ?', [a.user_id]);
  const [[statsBefore]] = await ctx.conn.query('SELECT * FROM user_stats WHERE user_id = ?', [a.user_id]);
  const d = await internal(lobby, 'POST', '/match/results', [
    { user_id: a.user_id, stats: stats(1, { numHillTakes: 3, numHillTakesByOpponents: 0 }), mode: 'domination' },
    { user_id: b.user_id, stats: stats(-1, { numHillTakes: 0, numHillTakesByOpponents: 3 }), mode: 'domination' },
  ]);
  const mine = d.players.find((p) => p.user_id === a.user_id).stats;
  assert.deepEqual(mine.mp_num_domination_matches_won_alltime, { value: 10, new_record: 0 }, 'the answer the lifetime accolades read');
  assert.equal(mine.numHillTakes, undefined, 'the answer carries no hill take');
  assert.equal(mine.numHillTakesByOpponents, undefined);
  const [[statsAfter]] = await ctx.conn.query('SELECT * FROM user_stats WHERE user_id = ?', [a.user_id]);
  assert.deepEqual(Object.keys(statsAfter), Object.keys(statsBefore), 'no column came of the hill takes');

  const now = Math.floor(Date.now() / 1000) + 60;
  const r = await internal(lobby, 'POST', '/match/accolades',
    { user_id: a.user_id, accolades: { _last_updated: now, WolvesatBay: 1, WhosHouse: 1, WhosHome: 1 } });
  assert.deepEqual(r.ignored_keys, ['WhosHome'], 'a key with no column is still refused (the measurement)');
  assert.equal(r.user_accolades.WolvesatBay.earned, 1);
  assert.equal(r.user_accolades.WhosHouse.earned, 1);
  assert.notEqual(r.user_accolades.WhosHouse.timeFirstEarned, null, 'a first is stamped');
  assert.equal(r.user_accolades.GlovesOff.earned, 0);

  const next = await internal(lobby, 'GET', `/users/${a.user_id}/accolades`);
  assert.equal(next.WhosHouse.earned, 1, 'the next match reads it earned: no first twice');
  assert.equal(next.WolvesatBay.earned, 1);
  assert.equal(next.GlovesOff.earned, 0);
  assert.equal(next.WhosHouse.earnRate, 50, 'one of the two accounts holds it');
  const other = await internal(lobby, 'GET', `/users/${b.user_id}/accolades`);
  assert.equal(other.WhosHouse.earned, 0);
});
