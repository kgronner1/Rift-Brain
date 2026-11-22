'use strict';
// RJ 587, the payload ledger, against a real database built from migrations/: 0009's table, the four statuses, a batch
// resent (or sent twice at once) counting once, carry's max(0, sent - balance) once per account, user_stats'
// _last_updated left as it was, the single-player sync's legacy branch (never lower, each rise journaled), the internal
// route's seat check and server-only sources, one transaction per call, the account's delete taking its rows, and every
// balance equal to its opening balance plus its rows. The races: match results, a legacy sync and two devices' credits,
// each with a credit (or a single-player sync) landing in the middle, and a delete landing after the account check. Runs only with RJ_TEST_DB set (see migrate.db.test.js); this file
// uses its own database, <name>_payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createPublicApp, createInternalApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { verify } = require('../src/auth/tokens');
const { deleteUser, applyPayloadEntries, applyLegacySpSync, postMatchPlayerStatsUpdate } = require('../src/storage');
const { SESSION_KEY, JOIN_KEY, LOBBY_MASTER_KEY, FP_A, ENV, makeRegistry, beat, lobbyKey, quietLogger } = require('./match_fixture');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const PASSWORD = 'ledger pilot password';
const ctx = { opening: new Map() };
const MATCH_STATS = {
  currencyDelta: 0, matchOutcome: 1, numJumps: 5, numHits: 0, numMisses: 0, numHitsReceived: 0, numKills: 0,
  numUniquePlayersKilled: 0, numDeaths: 0, numDeathsByOtherPlayers: 0, matchDurationSec: 60, timeSpentAliveSec: 60,
};
let seq = 0;

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
  const name = `${base}_payload`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  const r = await migrate(c, { log: () => {} });
  assert.ok(r.applied.includes('0009_payload_ledger.sql'), r.applied.join(', '));
  Object.assign(ctx, { conn: c, admin, name });
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
  await ctx.conn.end();
  await ctx.admin.query(`DROP DATABASE IF EXISTS \`${ctx.name}\``);
  await ctx.admin.end();
});

function headers(install, token) {
  const h = {
    'X-RJ-Api': '1', 'X-RJ-Build': '1', 'X-RJ-Wire': '17', 'X-RJ-Wire-Fp': FP_A, 'X-RJ-Env': 'dev',
    'X-RJ-Platform': 'android', 'X-RJ-Install': install,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function http(server, method, p, { headers: h = {}, body } = {}) {
  const init = { method, headers: { ...h } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, init);
  return { status: r.status, body: await r.json() };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

async function q(sql, params = []) {
  const [rows] = await getDB().query(sql, params);
  return rows;
}

async function signUp(username) {
  const install = `6f1c2b8e-0000-4000-8587-${String(++seq).padStart(12, '0')}`;
  const r = await http(ctx.pub, 'POST', '/v1/accounts', {
    headers: headers(install), body: { username, email: `${username.toLowerCase()}@example.test`, password: PASSWORD },
  });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return { id: r.body.data.user.id, username, install, session: r.body.data.session.token };
}

// The balance an account held before the ledger knew it (0009 does no backfill): set straight in user_stats.
async function opening(p, amount, earned) {
  await q('UPDATE user_stats SET currency_amount = ?, currency_earned_alltime = ? WHERE user_id = ?', [amount, earned, p.id]);
  ctx.opening.set(p.id, { amount, earned });
}

async function credit(p, entries) {
  const r = await http(ctx.pub, 'POST', '/v1/me/payload/credit', { headers: headers(p.install, p.session), body: { entries } });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return r.body.data;
}

async function serverCredit(uid, entries) {
  return http(ctx.int, 'POST', '/internal/v1/payload/credit', { headers: ctx.lh, body: { user_id: uid, entries } });
}

async function totals(uid) {
  const [row] = await q('SELECT currency_amount AS amount, currency_earned_alltime AS earned, _last_updated AS stamp FROM user_stats WHERE user_id = ?', [uid]);
  return { amount: Number(row.amount), earned: Number(row.earned), stamp: row.stamp.getTime() };
}

async function ledger(uid) {
  return q('SELECT ref, source, amount, balance_after FROM payload_ledger WHERE user_id = ? ORDER BY id', [uid]);
}

let stampSec = Math.floor(Date.now() / 1000) + 3600;
async function recordAccolades(p, accolades) {
  const r = await http(ctx.pub, 'POST', '/v1/me/accolades/sync', { headers: headers(p.install, p.session), body: { accolades: { _last_updated: ++stampSec, ...accolades } } });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
}

async function oldSync(p, stats, stamp = ++stampSec) {
  const r = await http(ctx.pub, 'POST', '/v1/me/sp-stats/sync', { headers: headers(p.install, p.session), body: { stats: { _last_updated: stamp, ...stats } } });
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  return r.body.data;
}

const run = (id, amount) => ({ ref: `run:${id}`, source: 'sp_run', amount });
const acc = (key, amount) => ({ ref: `accolade:${key}`, source: 'accolade', amount });

test('0009 makes payload_ledger: its columns, the (user_id, ref) key, the cascade; a second run changes nothing', { skip }, async () => {
  const cols = async () => Object.fromEntries((await ctx.conn.query(
    `SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS x
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payload_ledger' ORDER BY ORDINAL_POSITION`))[0]
    .map((r) => [r.c, `${r.t} ${r.n} ${r.d} ${r.x}`.trim()]));
  const before = await cols();
  assert.deepEqual(Object.keys(before), ['id', 'user_id', 'ref', 'source', 'amount', 'balance_after', 'created_at']);
  assert.match(before.id, /^bigint\(20\) unsigned NO null auto_increment$/);
  assert.match(before.user_id, /^int\(11\) NO null$/, 'users.user_id\'s type');
  assert.match(before.ref, /^varchar\(64\) NO null$/);
  assert.match(before.source, /^varchar\(16\) NO null$/);
  assert.match(before.amount, /^int\(11\) NO null$/);
  assert.match(before.balance_after, /^int\(11\) NO null$/);
  assert.match(before.created_at, /^timestamp NO current_timestamp\(\)$/, 'no ON UPDATE');
  const [keys] = await ctx.conn.query(
    `SELECT INDEX_NAME AS k, NON_UNIQUE AS nu, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payload_ledger' GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`);
  assert.deepEqual(keys.map((k) => `${k.k} ${k.nu} ${k.c}`).sort(), [
    'PRIMARY 0 id', 'ix_payload_ledger_user_created 1 user_id,created_at', 'uq_payload_ledger_user_ref 0 user_id,ref',
  ]);
  const [[fk]] = await ctx.conn.query(
    `SELECT REFERENCED_TABLE_NAME AS t, DELETE_RULE AS d FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'payload_ledger'`);
  assert.deepEqual(fk, { t: 'users', d: 'CASCADE' });

  await ctx.conn.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0009_payload_ledger.sql'), 'utf8'));
  assert.deepEqual(await cols(), before);
});

test('setup: pilots, one holding a balance from before the ledger', { skip }, async () => {
  for (const name of ['Ann', 'Bo', 'Cy', 'Di', 'Es', 'Fe', 'Gi', 'Hy', 'Li', 'Mo', 'Pa']) {
    ctx[name.toLowerCase()] = await signUp(`Ledger_${name}`);
    ctx.opening.set(ctx[name.toLowerCase()].id, { amount: 0, earned: 0 });
  }
  await opening(ctx.ann, 450, 900);
  await opening(ctx.cy, 450, 450);
  await opening(ctx.li, 500, 500);
  await opening(ctx.mo, 300, 300);
  assert.deepEqual(await credit(ctx.es, []), { balance: 0, earned_alltime: 0, entries: [] }, 'an empty array reads the balance');
  const read = await credit(ctx.ann, []);
  assert.deepEqual([read.balance, read.earned_alltime], [450, 900]);
  assert.equal(ctx.lines.some((l) => l.startsWith('[payload]')), false, 'a read is not logged');
});

test('each status, in the order sent: applied, duplicate, rejected for each reason, deferred', { skip }, async () => {
  const ann = ctx.ann;
  const d = await credit(ann, [
    run('ann00001', 120),
    run('ann00001', 120),
    acc('Ghost', 100),
    acc('NotAnAccolade', 100),
    { ref: 'legacy:forged', source: 'legacy_sync', amount: 5000 },
    run('short', 5),
    run('ann00002', 0),
    run('ann00003', 5001),
    run('ann00004', 1.5),
    acc('Ghost', 75),
    { ref: 'spend:1', source: 'spend', amount: 1 },
    { ref: 7, source: 'sp_run', amount: 1 },
    { ref: 'carry', source: 'carry', amount: 100001 },
    { ref: 'carry2', source: 'carry', amount: 1 },
    { source: 'sp_run' },
  ]);
  assert.deepEqual(d, {
    balance: 570,
    earned_alltime: 1020,
    entries: [
      { ref: 'run:ann00001', status: 'applied', credited: 120 },
      { ref: 'run:ann00001', status: 'duplicate' },
      { ref: 'accolade:Ghost', status: 'deferred', reason: 'accolade not recorded yet' },
      { ref: 'accolade:NotAnAccolade', status: 'rejected', reason: 'unknown accolade key' },
      { ref: 'legacy:forged', status: 'rejected', reason: 'source not allowed here' },
      { ref: 'run:short', status: 'rejected', reason: 'bad ref' },
      { ref: 'run:ann00002', status: 'rejected', reason: 'bad amount' },
      { ref: 'run:ann00003', status: 'rejected', reason: 'bad amount' },
      { ref: 'run:ann00004', status: 'rejected', reason: 'bad amount' },
      { ref: 'accolade:Ghost', status: 'rejected', reason: 'bad amount' },
      { ref: 'spend:1', status: 'rejected', reason: 'bad source' },
      { ref: null, status: 'rejected', reason: 'bad ref' },
      { ref: 'carry', status: 'rejected', reason: 'bad amount' },
      { ref: 'carry2', status: 'rejected', reason: 'bad ref' },
      { ref: null, status: 'rejected', reason: 'bad ref' },
    ],
  });
  assert.deepEqual(await ledger(ann.id), [{ ref: 'run:ann00001', source: 'sp_run', amount: 120, balance_after: 570 }]);
  assert.deepEqual([(await totals(ann.id)).amount, (await totals(ann.id)).earned], [570, 1020]);
  assert.ok(ctx.lines.includes(`[payload] user ${ann.id} (client): 1 applied, 1 duplicate, 12 rejected, 1 deferred; balance 570`), ctx.lines.join('\n'));

  // The deferred first pays once its accolade is recorded; again, it is a duplicate.
  await recordAccolades(ann, { Ghost: 1 });
  assert.deepEqual((await credit(ann, [acc('Ghost', 100)])).entries, [{ ref: 'accolade:Ghost', status: 'applied', credited: 100 }]);
  assert.deepEqual((await credit(ann, [acc('Ghost', 100)])).entries, [{ ref: 'accolade:Ghost', status: 'duplicate' }]);
  // A first already paid stays a duplicate when another device's sync puts its count back to 0 (not deferred forever).
  await recordAccolades(ann, { Ghost: 0 });
  const again = await credit(ann, [acc('Ghost', 100)]);
  assert.deepEqual([again.balance, again.entries], [670, [{ ref: 'accolade:Ghost', status: 'duplicate' }]]);
});

test('a whole batch resent counts once, and so do two copies sent at the same moment', { skip }, async () => {
  const bo = ctx.bo;
  await recordAccolades(bo, { Jumpy: 1 });
  const batch = [run('bo-batch-1', 10), run('bo-batch-2', 20), acc('Jumpy', 50)];
  const first = await credit(bo, batch);
  assert.deepEqual([first.balance, first.earned_alltime, first.entries.map((e) => e.status)], [80, 80, ['applied', 'applied', 'applied']]);
  const resent = await credit(bo, batch);
  assert.deepEqual([resent.balance, resent.earned_alltime], [80, 80]);
  assert.deepEqual(resent.entries, batch.map((e) => ({ ref: e.ref, status: 'duplicate' })));
  assert.equal((await ledger(bo.id)).length, 3);

  const twice = [run('bo-conc-1', 5), run('bo-conc-2', 7), run('bo-conc-3', 11)];
  const answers = await Promise.all([credit(bo, twice), credit(bo, twice), credit(bo, twice)]);
  for (const e of twice) {
    const applied = answers.filter((a) => a.entries.find((x) => x.ref === e.ref).status === 'applied').length;
    assert.equal(applied, 1, `${e.ref} applied once across three calls at once`);
  }
  assert.deepEqual([(await totals(bo.id)).amount, (await ledger(bo.id)).length], [103, 6]);
  assert.equal(Math.max(...answers.map((a) => a.balance)), 103);
});

test('carry: credits max(0, sent - the balance at its place in the batch), and counts once per account, ever', { skip }, async () => {
  // Cy held 450 before the ledger; this install's save says 500 and it earned a run of 20 since (the client sends
  // carry = its shown balance less its pending entries, and leads with it).
  const cy = await credit(ctx.cy, [{ ref: 'carry', source: 'carry', amount: 500 }, run('cy-run-0001', 20)]);
  assert.deepEqual(cy, { balance: 520, earned_alltime: 520, entries: [
    { ref: 'carry', status: 'applied', credited: 50 },
    { ref: 'run:cy-run-0001', status: 'applied', credited: 20 },
  ] });
  assert.deepEqual(await ledger(ctx.cy.id), [
    { ref: 'carry', source: 'carry', amount: 50, balance_after: 500 },
    { ref: 'run:cy-run-0001', source: 'sp_run', amount: 20, balance_after: 520 },
  ]);
  const second = await credit(ctx.cy, [{ ref: 'carry', source: 'carry', amount: 9000 }]);
  assert.deepEqual([second.balance, second.entries], [520, [{ ref: 'carry', status: 'duplicate' }]], 'a second carry, from any device, counts nothing');

  // An account already ahead of the install: the carry applies with 0, and its row still uses up the account's carry.
  await credit(ctx.di, [run('di-run-0001', 300)]);
  const behind = await credit(ctx.di, [{ ref: 'carry', source: 'carry', amount: 200 }]);
  assert.deepEqual([behind.balance, behind.entries], [300, [{ ref: 'carry', status: 'applied', credited: 0 }]]);
  assert.deepEqual((await ledger(ctx.di.id)).at(-1), { ref: 'carry', source: 'carry', amount: 0, balance_after: 300 });
  assert.deepEqual((await credit(ctx.di, [{ ref: 'carry', source: 'carry', amount: 5000 }])).entries, [{ ref: 'carry', status: 'duplicate' }]);
  assert.equal((await totals(ctx.di.id)).amount, 300);

  // A carry after another entry in the same batch measures against the balance that entry left.
  const es = await credit(ctx.es, [run('es-run-0001', 40), { ref: 'carry', source: 'carry', amount: 100 }]);
  assert.deepEqual(es.entries, [{ ref: 'run:es-run-0001', status: 'applied', credited: 40 }, { ref: 'carry', status: 'applied', credited: 60 }]);
  assert.equal(es.balance, 100);
});

test('a credit leaves user_stats._last_updated as it was, so an older single-player save still wins its sync', { skip }, async () => {
  const bo = ctx.bo;
  const backdate = () => q("UPDATE user_stats SET _last_updated = '2026-01-02 03:04:05' WHERE user_id = ?", [bo.id]);
  await backdate();
  const s0 = (await totals(bo.id)).stamp;
  // The measurement's control: an UPDATE that changes a column and says nothing of the stamp restamps the row.
  await q('UPDATE user_stats SET num_jumps_alltime = COALESCE(num_jumps_alltime, 0) + 1 WHERE user_id = ?', [bo.id]);
  assert.ok((await totals(bo.id)).stamp > s0 + 86400000, 'ON UPDATE current_timestamp() restamps an ordinary write');
  await backdate();
  assert.equal((await totals(bo.id)).stamp, s0);

  const before = await totals(bo.id);
  const d = await credit(bo, [run('bo-stamp-01', 15)]);
  assert.equal(d.entries[0].status, 'applied');
  const after = await totals(bo.id);
  assert.deepEqual([after.amount, after.stamp], [before.amount + 15, s0], 'credited, and the stamp as it was');
  await credit(bo, [run('bo-stamp-01', 15)]);
  await credit(bo, []);
  assert.equal((await totals(bo.id)).stamp, s0, 'a duplicate and a read leave it too');

  // The point of it: a save stamped after the row's stamp but long before the credit still wins the sp_ sync.
  const synced = await oldSync(bo, { sp_most_jumps_in_a_run: 42 }, Math.floor(s0 / 1000) + 60);
  assert.equal(synced.user_stats.sp_most_jumps_in_a_run, 42);
});

test('the legacy sync (0.2.0\'s absolute currency): never lower, each rise one legacy_sync row, the rest of the sync unchanged', { skip }, async () => {
  const fe = ctx.fe;
  await credit(fe, [run('fe-run-0001', 300)]);
  const rows = async () => (await ledger(fe.id)).filter((r) => r.source === 'legacy_sync');

  const lower = await oldSync(fe, { currency_amount: 100, currency_earned_alltime: 100, sp_most_jumps_in_a_run: 7, mp_num_kills_alltime: 5 });
  assert.deepEqual([lower.user_stats.currency_amount, lower.user_stats.currency_earned_alltime, lower.user_stats.sp_most_jumps_in_a_run],
    [300, 300, 7], 'the server credit survives; the sp_ key is written as sent');
  assert.deepEqual(lower.ignored_keys, ['mp_num_kills_alltime']);
  assert.deepEqual(await rows(), [], 'no rise, no row');

  const rise = await oldSync(fe, { currency_amount: 450, currency_earned_alltime: 460 });
  assert.deepEqual([rise.user_stats.currency_amount, rise.user_stats.currency_earned_alltime], [450, 460]);
  const [legacy] = await rows();
  assert.match(legacy.ref, /^legacy:[0-9a-f]{24}$/);
  assert.deepEqual([legacy.amount, legacy.balance_after], [150, 450]);
  assert.ok(ctx.lines.includes(`[payload] user ${fe.id}: a legacy single-player sync raised the balance by 150 (${legacy.ref})`));

  const earnedOnly = await oldSync(fe, { currency_amount: 450, currency_earned_alltime: 500 });
  assert.deepEqual([earnedOnly.user_stats.currency_amount, earnedOnly.user_stats.currency_earned_alltime], [450, 500]);
  assert.deepEqual((await rows()).map((r) => [r.amount, r.balance_after]), [[150, 450], [0, 450]], 'an all-time rise alone: a row of 0');

  await oldSync(fe, { currency_amount: 450, currency_earned_alltime: 500 });
  const stale = await oldSync(fe, { currency_amount: 9999, currency_earned_alltime: 9999 }, 1000);
  assert.deepEqual([stale.user_stats.currency_amount, stale.user_stats.currency_earned_alltime], [450, 500], 'a stale stamp writes nothing');
  const amountOnly = await oldSync(fe, { currency_amount: 470.4 });
  assert.deepEqual([amountOnly.user_stats.currency_amount, amountOnly.user_stats.currency_earned_alltime], [470, 500]);
  assert.deepEqual((await rows()).map((r) => r.amount), [150, 0, 20]);
  assert.equal(new Set((await rows()).map((r) => r.ref)).size, 3, 'every legacy ref is its own');

  // The ledger build's sync sends no currency: the sp_ columns as ever, the balance untouched, no row.
  const modern = await oldSync(fe, { sp_most_jumps_in_a_run: 9 });
  assert.deepEqual([modern.user_stats.currency_amount, modern.user_stats.sp_most_jumps_in_a_run], [470, 9]);
  const after = await credit(fe, [run('fe-run-0002', 30)]);
  assert.deepEqual([after.balance, after.earned_alltime], [500, 530]);
  assert.equal((await rows()).length, 3);
});

// A player joins quickplay and takes the seat its token reserved (player-joined), as the game server reports.
async function seat(p) {
  const { reg } = ctx.m;
  let r = await http(ctx.pub, 'POST', '/v1/match/join', { headers: headers(p.install, p.session), body: { mode: 'quickplay' } });
  const lobby = [...reg.lobbies.values()][0];
  if (r.body.result === 'queued') {
    if (lobby.state === 'BOOTING') await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
    r = await http(ctx.pub, 'GET', `/v1/queue/${r.body.queued.ticket}`, { headers: headers(p.install, p.session) });
  }
  assert.equal(code(r), 'ok', JSON.stringify(r.body));
  const tok = verify(r.body.data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(ctx.m.clock.t / 1000) });
  ctx.lh = { 'X-RJ-Lobby': lobby.id, 'X-RJ-Lobby-Key': lobbyKey(lobby.id), 'X-RJ-Wire': '17' };
  const joined = await http(ctx.int, 'POST', '/internal/v1/lobby/player-joined', { headers: ctx.lh, body: { user_id: p.id, seat: tok.payload.seat } });
  assert.equal(joined.status, 200);
}

test('the internal route: a seated player only, accolade entries only, and a first paid once through either route', { skip }, async () => {
  const gi = ctx.gi;
  await recordAccolades(gi, { Ghost: 1, Jumpy: 2 });
  await seat(gi);
  const s0 = (await totals(gi.id)).stamp;

  const unseated = await serverCredit(ctx.hy.id, [acc('Ghost', 100)]);
  assert.deepEqual([unseated.status, code(unseated)], [403, 'VALIDATION']);
  assert.deepEqual(await ledger(ctx.hy.id), []);

  const r = await serverCredit(gi.id, [
    acc('Ghost', 250),
    run('gi-run-0001', 10),
    { ref: 'carry', source: 'carry', amount: 10 },
    { ref: 'legacy:x', source: 'legacy_sync', amount: 10 },
    acc('Pyromaniac', 50),
    acc('Nope', 50),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { balance: 250, earned_alltime: 250, entries: [
    { ref: 'accolade:Ghost', status: 'applied', credited: 250 },
    { ref: 'run:gi-run-0001', status: 'rejected', reason: 'source not allowed here' },
    { ref: 'carry', status: 'rejected', reason: 'source not allowed here' },
    { ref: 'legacy:x', status: 'rejected', reason: 'source not allowed here' },
    { ref: 'accolade:Pyromaniac', status: 'deferred', reason: 'accolade not recorded yet' },
    { ref: 'accolade:Nope', status: 'rejected', reason: 'unknown accolade key' },
  ] });
  assert.ok(ctx.lines.includes(`[payload] user ${gi.id} (server): 1 applied, 0 duplicate, 4 rejected, 1 deferred; balance 250`));
  assert.equal((await totals(gi.id)).stamp, s0, 'the server\'s credit leaves the stamp too');

  // The same first through single player after multiplayer, and the other way round: paid once.
  const sp = await credit(gi, [acc('Ghost', 250), acc('Jumpy', 100)]);
  assert.deepEqual(sp.entries, [{ ref: 'accolade:Ghost', status: 'duplicate' }, { ref: 'accolade:Jumpy', status: 'applied', credited: 100 }]);
  const mp = await serverCredit(gi.id, [acc('Jumpy', 100)]);
  assert.deepEqual([mp.body.data.balance, mp.body.data.entries], [350, [{ ref: 'accolade:Jumpy', status: 'duplicate' }]]);
});

test('a credit is one transaction: a failure part way leaves no row and the totals as they were', { skip }, async () => {
  const hy = ctx.hy;
  const pool = getDB();
  const failing = {
    async getConnection() {
      const c = await pool.getConnection();
      return new Proxy(c, {
        get(target, key) {
          if (key === 'execute') {
            return (sql, params) => (/^\s*UPDATE user_stats/.test(sql) ? Promise.reject(new Error('stats write failed')) : target.execute(sql, params));
          }
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
  const before = await totals(hy.id);
  await assert.rejects(applyPayloadEntries(hy.id, [run('hy-run-0001', 10), run('hy-run-0002', 20)], { from: 'client', db: failing }), /stats write failed/);
  assert.deepEqual(await ledger(hy.id), []);
  assert.deepEqual(await totals(hy.id), before);
  const ok = await credit(hy, [run('hy-run-0001', 10), run('hy-run-0002', 20)]);
  assert.deepEqual(ok.entries.map((e) => e.status), ['applied', 'applied'], 'nothing was left behind to make them duplicates');
});

// A pool stand-in for one call: right after the first statement matching `re` returns on one of its connections,
// `during` starts (another request, on the real pool) and the call is held until `during` settles or holdMs pass. With
// the rows locked, `during` is still waiting when the call goes on (state.doneInHold false); unlocked, it finishes in the
// hold and the call then writes over it.
function interleaved(re, during, holdMs = 500) {
  const pool = getDB();
  const state = { fired: false, done: false, doneInHold: null, during: null };
  const db = {
    execute: (sql, params) => pool.execute(sql, params),
    query: (sql, params) => pool.query(sql, params),
    async getConnection() {
      const c = await pool.getConnection();
      const execute = async (sql, params) => {
        const r = await c.execute(sql, params);
        if (!state.fired && re.test(sql)) {
          state.fired = true;
          state.during = Promise.resolve().then(during);
          state.during.then(() => { state.done = true; }, () => { state.done = true; });
          await Promise.race([state.during.catch(() => {}), new Promise((resolve) => setTimeout(resolve, holdMs))]);
          state.doneInHold = state.done;
        }
        return r;
      };
      return new Proxy(c, {
        get(target, key) {
          if (key === 'execute') return execute;
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
  return { db, state };
}

const RESULTS_READ = /^\s*SELECT \* FROM user_stats WHERE user_id = \?/;

test('match results: a credit landing between their read and their write waits for them, and survives', { skip }, async () => {
  const li = ctx.li;
  const wonBefore = Number((await q('SELECT mp_num_matches_won_alltime AS n FROM user_stats WHERE user_id = ?', [li.id]))[0].n);
  const { db, state } = interleaved(RESULTS_READ, () => credit(li, [run('li-race-0001', 100)]));
  const results = await postMatchPlayerStatsUpdate([{ user_id: li.id, stats: { ...MATCH_STATS } }], { db });
  const paid = await state.during;
  assert.equal(state.fired, true, 'the hook found the results\' read (the measurement works)');
  assert.deepEqual([paid.balance, paid.entries], [600, [{ ref: 'run:li-race-0001', status: 'applied', credited: 100 }]]);
  const t = await totals(li.id);
  assert.deepEqual([t.amount, t.earned], [600, 600], 'the credit was not written over');
  assert.equal(state.doneInHold, false, 'the credit waited on the row the results locked');
  assert.equal(results[0].stats.currency_amount.value, 500, 'the results\' answer is from before the credit');
  assert.equal(Number((await q('SELECT mp_num_matches_won_alltime AS n FROM user_stats WHERE user_id = ?', [li.id]))[0].n), wonBefore + 1);
  assert.equal(t.amount, ctx.opening.get(li.id).amount + (await ledger(li.id)).reduce((n, r) => n + r.amount, 0));
});

test('match results: a single-player sync landing in between keeps its stamp (the results never put an older one back)', { skip }, async () => {
  const li = ctx.li;
  await q("UPDATE user_stats SET _last_updated = '2026-01-02 03:04:05' WHERE user_id = ?", [li.id]);
  const s0 = (await totals(li.id)).stamp;
  const { db, state } = interleaved(RESULTS_READ, () => oldSync(li, { sp_most_jumps_in_a_run: 33 }));
  await postMatchPlayerStatsUpdate([{ user_id: li.id, stats: { ...MATCH_STATS } }], { db });
  const synced = await state.during;
  assert.equal(synced.user_stats.sp_most_jumps_in_a_run, 33);
  const t = await totals(li.id);
  assert.ok(t.stamp > s0 + 86400000, `the sync's restamp stands (${new Date(t.stamp).toISOString()})`);
  assert.equal(state.doneInHold, false, 'the sync\'s write waited on the locked row');
  assert.equal(t.amount, 600);
  // And the results alone leave the stamp as it was.
  await q("UPDATE user_stats SET _last_updated = '2026-01-02 03:04:05' WHERE user_id = ?", [li.id]);
  await postMatchPlayerStatsUpdate([{ user_id: li.id, stats: { ...MATCH_STATS } }]);
  assert.equal((await totals(li.id)).stamp, s0);
});

test('a legacy sync with a credit landing in its middle: both count, once each, and the balance stays the ledger\'s', { skip }, async () => {
  const mo = ctx.mo;
  const stamp = ++stampSec;
  const { db, state } = interleaved(/UNIX_TIMESTAMP\(_last_updated\) < \?/, () => credit(mo, [run('mo-race-0001', 100)]));
  const ref = await applyLegacySpSync(mo.id, {
    stats: { currency_amount: 450, currency_earned_alltime: 450, _last_updated: stamp }, keys: ['currency_amount', 'currency_earned_alltime'], lastUpdated: stamp,
  }, { db });
  const paid = await state.during;
  assert.equal(state.fired, true);
  assert.match(ref, /^legacy:/);
  assert.deepEqual(paid.entries, [{ ref: 'run:mo-race-0001', status: 'applied', credited: 100 }]);
  assert.deepEqual([(await totals(mo.id)).amount, (await totals(mo.id)).earned], [550, 550], 'the credit was not written over');
  assert.deepEqual(await ledger(mo.id), [
    { ref, source: 'legacy_sync', amount: 150, balance_after: 450 },
    { ref: 'run:mo-race-0001', source: 'sp_run', amount: 100, balance_after: 550 },
  ]);
  assert.equal(state.doneInHold, false, 'the credit waited on the legacy sync\'s locked row');

  // The same race from the routes, many times over: the balance is always the opening balance plus the ledger.
  for (let i = 0; i < 6; i++) {
    const sent = (await totals(mo.id)).amount + 40;
    await Promise.all([oldSync(mo, { currency_amount: sent, currency_earned_alltime: sent + 1000 }), credit(mo, [run(`mo-race-loop-${i}`, 7)])]);
    const t = await totals(mo.id);
    assert.equal(t.amount, ctx.opening.get(mo.id).amount + (await ledger(mo.id)).reduce((n, r) => n + r.amount, 0), `round ${i}`);
  }
});

test('two devices crediting one account at once, every ref its own: every entry counts', { skip }, async () => {
  const pa = ctx.pa;
  const calls = Array.from({ length: 8 }, (_, i) => [run(`pa-dev${i}-a`, 10 + i), run(`pa-dev${i}-b`, 100 + i)]);
  const answers = await Promise.all(calls.map((entries) => credit(pa, entries)));
  for (const a of answers) assert.deepEqual(a.entries.map((e) => e.status), ['applied', 'applied']);
  const sum = calls.flat().reduce((n, e) => n + e.amount, 0);
  const t = await totals(pa.id);
  assert.deepEqual([t.amount, t.earned], [sum, sum], 'no call wrote over another\'s');
  assert.equal(new Set(answers.map((a) => a.balance)).size, 8, 'each call saw the one before it');
  assert.equal(Math.max(...answers.map((a) => a.balance)), sum);
  const rows = await ledger(pa.id);
  assert.deepEqual(rows.map((r) => r.balance_after), rows.map((r, i) => rows.slice(0, i + 1).reduce((n, x) => n + x.amount, 0)));
});

test('a delete landing after the account check is AUTH_INVALID; an account with no user_stats row fails, keeping its entries', { skip }, async () => {
  const ni = await signUp('Ledger_Ni');
  await credit(ni, [run('ni-run-0001', 10)]);
  const pool = getDB();
  let fired = false;
  pool.execute = async function hooked(sql, params) {
    const r = await Object.getPrototypeOf(pool).execute.call(pool, sql, params);
    if (!fired && /SELECT 1 AS present FROM users/.test(sql) && params[0] === ni.id) {
      fired = true;
      await deleteUser(ni.id);
    }
    return r;
  };
  let late;
  try {
    late = await http(ctx.pub, 'POST', '/v1/me/payload/credit', { headers: headers(ni.install, ni.session), body: { entries: [run('ni-run-0002', 10)] } });
  } finally {
    delete pool.execute;
  }
  assert.equal(fired, true, 'the delete landed between the check and the ledger');
  assert.deepEqual([code(late), late.status, late.body.error.scope], ['AUTH_INVALID', 401, 'account']);
  assert.deepEqual(await ledger(ni.id), []);
  assert.equal(await applyPayloadEntries(ni.id, [run('ni-run-0003', 10)]), null, 'the ledger says "gone", not an answer');

  const oz = await signUp('Ledger_Oz');
  await q('DELETE FROM user_stats WHERE user_id = ?', [oz.id]);
  const broken = await http(ctx.pub, 'POST', '/v1/me/payload/credit', { headers: headers(oz.install, oz.session), body: { entries: [run('oz-run-0001', 10)] } });
  assert.deepEqual([code(broken), broken.status], ['INTERNAL', 500], 'not ok: the client keeps its entries');
  await assert.rejects(applyPayloadEntries(oz.id, [acc('Ghost', 100)], { from: 'server' }), /No matching user stats found/);
  assert.deepEqual(await ledger(oz.id), []);
  const read = await http(ctx.pub, 'POST', '/v1/me/payload/credit', { headers: headers(oz.install, oz.session), body: { entries: [] } });
  assert.equal(code(read), 'INTERNAL', 'a read too: no balance to tell');
});

test('every balance is its opening balance plus its rows; the all-time total likewise for the credit routes', { skip }, async () => {
  let checked = 0;
  for (const [uid, open] of ctx.opening) {
    const t = await totals(uid);
    const rows = await ledger(uid);
    const sum = rows.reduce((n, r) => n + r.amount, 0);
    assert.equal(t.amount, open.amount + sum, `user ${uid}: balance`);
    if (rows.length) assert.equal(rows.at(-1).balance_after, t.amount, `user ${uid}: the last row's balance_after`);
    if (!rows.some((r) => r.source === 'legacy_sync')) {
      assert.equal(t.earned, open.earned + rows.filter((r) => r.amount > 0).reduce((n, r) => n + r.amount, 0), `user ${uid}: all-time`);
    }
    checked += rows.length ? 1 : 0;
  }
  assert.ok(checked >= 7, `accounts with rows: ${checked}`);
});

test('account deletion takes the ledger rows: deleteUser names the table, and the foreign key cascades', { skip }, async () => {
  const ji = await signUp('Ledger_Ji');
  await credit(ji, [run('ji-run-0001', 10), { ref: 'carry', source: 'carry', amount: 0 }]);
  assert.equal((await ledger(ji.id)).length, 2);
  assert.equal(await deleteUser(ji.id), true);
  assert.deepEqual(await ledger(ji.id), []);
  const gone = await http(ctx.pub, 'POST', '/v1/me/payload/credit', { headers: headers(ji.install, ji.session), body: { entries: [run('ji-run-0002', 10)] } });
  assert.deepEqual([code(gone), gone.body.error.scope], ['AUTH_INVALID', 'account'], 'a still-valid session writes nothing');
  assert.deepEqual(await ledger(ji.id), []);

  const ki = await signUp('Ledger_Ki');
  await credit(ki, [run('ki-run-0001', 10)]);
  for (const t of ['invites', 'user_credentials', 'user_player_card', 'user_accolades_time_earned', 'user_accolades', 'user_stats']) {
    await q(`DELETE FROM ${t} WHERE user_id = ?`, [ki.id]);
  }
  assert.equal((await ledger(ki.id)).length, 1);
  await q('DELETE FROM users WHERE user_id = ?', [ki.id]);
  assert.deepEqual(await ledger(ki.id), [], 'ON DELETE CASCADE');
  assert.equal((await q('SELECT COUNT(*) AS n FROM payload_ledger WHERE user_id IN (?, ?)', [ji.id, ki.id]))[0].n, 0);
});
