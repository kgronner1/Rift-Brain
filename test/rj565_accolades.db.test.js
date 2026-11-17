'use strict';
// RJ 565, against a real database built from migrations/: 0008's seventeen accolade columns in both accolade tables and
// user_stats.sp_num_rivals_killed_alltime and sp_most_rivals_killed_in_a_run, a second run changing nothing, and both syncs taking the new keys -- an
// accolade earned (with its first-earned time) and both kills stats. Runs only with RJ_TEST_DB set (see
// migrate.db.test.js); this file uses its own database, <name>_rj565.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/migrate');
const { initDB, getDB } = require('../src/db');
const { createAccount, playerAccoladesSync, singlePlayerStatsSync, getUserAccolades } = require('../src/storage');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';
const ACCOLADES = ['FirstBlood', 'EasyStreet', 'PieceofCake', 'Bulldozer', 'BountyHunter', 'Ditto', 'Demolitionist',
  'TwoBirds', 'ChainReaction', 'BaitandSwitch', 'EcoFriendly', 'GreenerMachine', 'CleanSheet', 'Pathfinder',
  'WalktheLine', 'RidetheLine', 'Navigator'];
const KILLS = 'sp_num_rivals_killed_alltime';
const MOST = 'sp_most_rivals_killed_in_a_run';
const ctx = {};

test.before(async () => {
  if (skip) return;
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(base, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const name = `${base}_rj565`;
  const auth = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection({ ...auth, multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET latin1`);
  const c = await mysql.createConnection({ ...auth, database: name, multipleStatements: true });
  const r = await migrate(c, { log: () => {} });
  assert.ok(r.applied.includes('0008_rj565_accolades.sql'), r.applied.join(', '));
  Object.assign(ctx, { conn: c, admin, name });
  initDB({ ...auth, database: name });
});

test.after(async () => {
  if (skip) return;
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

test('0008 adds every accolade to both tables and the kills total to user_stats, and a second run changes nothing', { skip }, async () => {
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
  const stats = await columns('user_stats');
  for (const col of [KILLS, MOST]) {
    assert.ok(stats[col], col);
    assert.equal(String(stats[col].d), '0', col);
  }

  const before = [Object.keys(counts).length, Object.keys(times).length, Object.keys(stats).length];
  await ctx.conn.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0008_rj565_accolades.sql'), 'utf8'));
  const after = [Object.keys(await columns('user_accolades')).length, Object.keys(await columns('user_accolades_time_earned')).length,
    Object.keys(await columns('user_stats')).length];
  assert.deepEqual(after, before);
});

test('both syncs take the new keys: an accolade earned, with its first-earned time, and the all-time kills', { skip }, async () => {
  const { user_id } = await createAccount({ username: 'Bounty_Hunter', email: 'bounty@example.test', password: 'a real pilot password' },
    { platform: 'android', installId: '6f1c2b8e-0000-4000-8565-000000000001' });
  const fresh = await getUserAccolades(user_id);
  for (const key of ACCOLADES) assert.equal(fresh[key].earned, 0, key);

  const now = Math.floor(Date.now() / 1000) + 60;
  const a = await playerAccoladesSync({ user_id, accolades: { _last_updated: now, BountyHunter: 1, Ditto: 2 } });
  assert.deepEqual(a.ignored_keys, []);
  assert.equal(a.user_accolades.BountyHunter.earned, 1);
  assert.equal(a.user_accolades.Ditto.earned, 2);
  assert.notEqual(a.user_accolades.BountyHunter.timeFirstEarned, null);
  assert.equal(a.user_accolades.Navigator.earned, 0);

  const s = await singlePlayerStatsSync({ user_id, stats: { _last_updated: now, [KILLS]: 312, [MOST]: 41 } });
  assert.deepEqual(s.ignored_keys, []);
  assert.equal(Number(s.user_stats[KILLS]), 312);
  assert.equal(Number(s.user_stats[MOST]), 41);
});
