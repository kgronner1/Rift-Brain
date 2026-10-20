'use strict';
// Runs only with RJ_TEST_DB=mysql://user:pass@host:port/<name containing "test">. The database is dropped and
// recreated by every test, so the name must say it is disposable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate, MIGRATIONS_DIR } = require('../src/migrate');

const URL_ENV = process.env.RJ_TEST_DB;
const skip = URL_ENV ? false : 'RJ_TEST_DB is not set';

// Today's users table in miniature: the columns and key shape 0002 depends on, and no unique keys,
// so 0002 has to add them.
const FIXTURE_BASELINE = `
CREATE TABLE users (
  user_id int(10) unsigned NOT NULL AUTO_INCREMENT,
  username varchar(64) NOT NULL,
  email varchar(255) NOT NULL,
  password varchar(255) NOT NULL,
  access_token varchar(255) DEFAULT NULL,
  last_login datetime DEFAULT NULL,
  created_date datetime DEFAULT NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE user_stats (
  user_id int(11) NOT NULL,
  currency_amount int(11) DEFAULT 0,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function freshDatabase(t) {
  const mysql = require('mysql2/promise');
  const url = new URL(URL_ENV);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  assert.match(name, /test/, 'RJ_TEST_DB must name a database containing "test": it is dropped');
  const admin = await mysql.createConnection({ uri: `${url.protocol}//${url.username}:${url.password}@${url.host}/` });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\``);
  await admin.end();
  const conn = await mysql.createConnection({ uri: URL_ENV, multipleStatements: true });
  t.after(() => conn.end());
  return conn;
}

function migrationsDir(t, withRealBaseline = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-migrate-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baseline = withRealBaseline
    ? fs.readFileSync(path.join(MIGRATIONS_DIR, '0001_baseline.sql'), 'utf8')
    : FIXTURE_BASELINE;
  fs.writeFileSync(path.join(dir, '0001_baseline.sql'), baseline);
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0002_hardening.sql'), path.join(dir, '0002_hardening.sql'));
  return dir;
}

async function columns(conn, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return rows.map((r) => r.c);
}

async function uniqueKeys(conn, table) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME AS k, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0 GROUP BY INDEX_NAME`, [table]);
  return rows.map((r) => r.cols).sort();
}

async function assertHardened(conn) {
  assert.ok(!(await columns(conn, 'users')).includes('access_token'));
  const unique = await uniqueKeys(conn, 'users');
  assert.ok(unique.includes('username') && unique.includes('email'), unique.join(' | '));
  assert.deepEqual((await columns(conn, 'user_credentials')).sort(),
    ['created_at', 'id', 'install_id', 'last_used_at', 'platform', 'revoked_at', 'token_hash', 'user_id']);
}

const quiet = () => {};

test('a fresh database builds from 0001 and hardens with 0002, then is up to date', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = migrationsDir(t);
  const r = await migrate(conn, { dir, log: quiet });
  assert.deepEqual(r.applied, ['0001_baseline.sql', '0002_hardening.sql']);
  await assertHardened(conn);

  await conn.query("INSERT INTO users (username, email, password) VALUES ('a', 'a@x.io', 'h')");
  await assert.rejects(conn.query("INSERT INTO users (username, email, password) VALUES ('a', 'b@x.io', 'h')"), /Duplicate/);
  await conn.query("INSERT INTO user_credentials (user_id, token_hash, platform, install_id) VALUES (1, REPEAT('a', 64), 'android', 'i')");
  await conn.query('DELETE FROM users WHERE user_id = 1');
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM user_credentials');
  assert.equal(Number(n), 0, 'credentials go with their user');

  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, []);
});

test('0002 runs again cleanly after it already ran (a half-applied run can be retried)', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = migrationsDir(t);
  await migrate(conn, { dir, log: quiet });
  await conn.query(fs.readFileSync(path.join(dir, '0002_hardening.sql'), 'utf8'));
  await assertHardened(conn);
  assert.equal((await uniqueKeys(conn, 'users')).filter((k) => k === 'username').length, 1);
});

test('a copy of today\'s database is baselined, then hardened', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = migrationsDir(t);
  await conn.query(FIXTURE_BASELINE);
  await assert.rejects(migrate(conn, { dir, log: quiet }), /already has tables .*migrate --baseline first/);

  const marked = await migrate(conn, { dir, baseline: true, log: quiet });
  assert.deepEqual(marked.marked, ['0001_baseline.sql']);
  assert.deepEqual(marked.applied, []);
  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, ['0002_hardening.sql']);
  await assertHardened(conn);
});

test('baselining an empty database is refused', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  await assert.rejects(migrate(conn, { dir: migrationsDir(t), baseline: true, log: quiet }), /no tables to baseline/);
});

test('a migration edited after it ran stops the next run', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = migrationsDir(t);
  await migrate(conn, { dir, log: quiet });
  fs.appendFileSync(path.join(dir, '0002_hardening.sql'), '\n-- edited\n');
  await assert.rejects(migrate(conn, { dir, log: quiet }), /0002_hardening\.sql changed after it was applied/);
});

const realBaseline = fs.existsSync(path.join(MIGRATIONS_DIR, '0001_baseline.sql'));
test('the real baseline builds and hardens', { skip: skip || (!realBaseline && 'migrations/0001_baseline.sql is not there yet') },
  async (t) => {
    const conn = await freshDatabase(t);
    const r = await migrate(conn, { dir: migrationsDir(t, true), log: quiet });
    assert.deepEqual(r.applied, ['0001_baseline.sql', '0002_hardening.sql']);
    await assertHardened(conn);
    for (const table of ['user_stats', 'user_accolades', 'user_accolades_time_earned', 'user_player_card']) {
      assert.ok((await columns(conn, table)).includes('user_id'), table);
    }
  });

// The real chain up to `upTo` (inclusive) in a temporary directory.
function realMigrations(t, upTo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-migrate-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (/^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= upTo) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return dir;
}

async function usersColumn(conn, name) {
  const [[c]] = await conn.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll, COLUMN_DEFAULT AS def
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = ?`, [name]);
  return c;
}

test('RJ 493: 0004 on a populated users table keeps every row, adds is_guest 0, frees email and password, and reruns cleanly', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = realMigrations(t, 3);
  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, ['0001_baseline.sql', '0002_hardening.sql', '0003_feedback.sql']);
  for (let i = 1; i <= 40; i++) {
    await conn.query('INSERT INTO users (username, email, password, last_login, created_date) VALUES (?, ?, ?, ?, NOW())',
      [`pilot_${i}`, `p${i}@x.io`, `$2a$10$hash${i}`, i % 2 ? null : '2026-01-02 03:04:05']);
    await conn.query('INSERT INTO user_stats (user_id, sp_most_jumps_in_a_run) VALUES (?, ?)', [i, i * 10]);
  }
  await conn.query("INSERT INTO user_credentials (user_id, token_hash, platform, install_id) VALUES (1, REPEAT('b', 64), 'ios', 'i')");
  const before = { email: await usersColumn(conn, 'email'), password: await usersColumn(conn, 'password') };
  assert.equal(before.email.nullable, 'NO', 'the measurement: 0001 makes them NOT NULL');
  const [rowsBefore] = await conn.query('SELECT user_id, username, email, password, last_login, created_date FROM users ORDER BY user_id');

  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0004_guests.sql'), path.join(dir, '0004_guests.sql'));
  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, ['0004_guests.sql']);

  const [rowsAfter] = await conn.query('SELECT user_id, username, email, password, last_login, created_date FROM users ORDER BY user_id');
  assert.deepEqual(rowsAfter, rowsBefore, 'every row as it was');
  const [[{ guests, n }]] = await conn.query('SELECT SUM(is_guest) AS guests, COUNT(*) AS n FROM users');
  assert.deepEqual([Number(guests), Number(n)], [0, 40]);
  for (const name of ['email', 'password']) {
    const c = await usersColumn(conn, name);
    assert.deepEqual([c.type, c.cs, c.coll], [before[name].type, before[name].cs, before[name].coll], `${name} keeps its type and collation`);
    assert.equal(c.nullable, 'YES', name);
  }
  const isGuest = await usersColumn(conn, 'is_guest');
  assert.deepEqual([isGuest.type, isGuest.nullable, String(isGuest.def)], ['tinyint(1)', 'NO', '0']);
  const unique = await uniqueKeys(conn, 'users');
  assert.ok(unique.includes('username') && unique.includes('email'), unique.join(' | '));
  const [idx] = await conn.query(
    `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'ix_users_guest_login'`);
  assert.equal(idx[0].cols, 'is_guest,last_login');
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM user_credentials'))[0][0].n), 1);
  assert.equal(Number((await conn.query('SELECT SUM(sp_most_jumps_in_a_run) AS s FROM user_stats'))[0][0].s), 8200);

  await conn.query(fs.readFileSync(path.join(dir, '0004_guests.sql'), 'utf8'));
  assert.equal((await uniqueKeys(conn, 'users')).filter((k) => k === 'email').length, 1, 'a rerun adds nothing');
  const [[{ k }]] = await conn.query(
    "SELECT COUNT(DISTINCT INDEX_NAME) AS k FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'ix_users_guest_login'");
  assert.equal(Number(k), 1);

  for (let i = 0; i < 50; i++) {
    await conn.query('INSERT INTO users (username, email, password, is_guest) VALUES (?, NULL, NULL, 1)', [`Pilot-${1000 + i}`]);
  }
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM users WHERE email IS NULL'))[0][0].n), 50, 'any number of NULL emails');
  await assert.rejects(conn.query("INSERT INTO users (username, email, password) VALUES ('Pilot-1000', NULL, NULL)"), /Duplicate/);
  await assert.rejects(conn.query("INSERT INTO users (username, email, password) VALUES ('other', 'p1@x.io', 'h')"), /Duplicate/);
});

test('RJ 493: 0004 also applies over a baselined copy of today\'s database (dev\'s history)', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = migrationsDir(t);
  await conn.query(FIXTURE_BASELINE);
  await conn.query("INSERT INTO users (username, email, password) VALUES ('kept', 'k@x.io', 'h')");
  await migrate(conn, { dir, baseline: true, log: quiet });
  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0004_guests.sql'), path.join(dir, '0004_guests.sql'));
  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, ['0002_hardening.sql', '0004_guests.sql']);
  assert.equal((await usersColumn(conn, 'email')).nullable, 'YES');
  assert.equal((await usersColumn(conn, 'email')).cs, 'utf8mb4', 'the copy\'s own character set, not the table default\'s guess');
  assert.deepEqual((await conn.query('SELECT username, email, is_guest FROM users'))[0], [{ username: 'kept', email: 'k@x.io', is_guest: 0 }]);
});

async function statsDefault(conn, name) {
  const [[c]] = await conn.query(
    `SELECT COLUMN_DEFAULT AS def FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_stats' AND COLUMN_NAME = ?`, [name]);
  return c.def === null ? null : String(c.def);
}

test('RJ 495: 0005 backfills the NULL stats and defaults both columns to 0, and reruns cleanly', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = realMigrations(t, 4);
  await migrate(conn, { dir, log: quiet });
  for (let i = 1; i <= 3; i++) await conn.query('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [`u${i}`, `u${i}@x.io`, 'h']);
  await conn.query('INSERT INTO user_stats (user_id) VALUES (1)');
  await conn.query('INSERT INTO user_stats (user_id, num_jumps_alltime, mp_num_items_stolen_alltime) VALUES (2, 77, 5)');
  const [[before]] = await conn.query('SELECT num_jumps_alltime AS j, mp_num_items_stolen_alltime AS s FROM user_stats WHERE user_id = 1');
  assert.deepEqual([before.j, before.s], [null, null], 'the measurement: 0001 leaves a new row NULL here');

  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0005_stats_defaults.sql'), path.join(dir, '0005_stats_defaults.sql'));
  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, ['0005_stats_defaults.sql']);

  const [rows] = await conn.query('SELECT user_id, num_jumps_alltime AS j, mp_num_items_stolen_alltime AS s FROM user_stats ORDER BY user_id');
  assert.deepEqual(rows.map((r) => [r.user_id, r.j, r.s]), [[1, 0, 0], [2, 77, 5]], 'NULLs become 0; values are kept');
  await conn.query('INSERT INTO user_stats (user_id) VALUES (3)');
  const [[fresh]] = await conn.query('SELECT num_jumps_alltime AS j, mp_num_items_stolen_alltime AS s FROM user_stats WHERE user_id = 3');
  assert.deepEqual([fresh.j, fresh.s], [0, 0], 'a new row starts at 0');
  assert.deepEqual([await statsDefault(conn, 'num_jumps_alltime'), await statsDefault(conn, 'mp_num_items_stolen_alltime')], ['0', '0']);

  await conn.query(fs.readFileSync(path.join(dir, '0005_stats_defaults.sql'), 'utf8'));
  assert.equal(Number((await conn.query('SELECT COUNT(*) AS n FROM user_stats'))[0][0].n), 3, 'a rerun changes nothing');
});

async function feedbackShape(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, COLLATION_NAME AS coll
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' ORDER BY ORDINAL_POSITION`);
  const [keys] = await conn.query(
    `SELECT INDEX_NAME AS k, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' GROUP BY INDEX_NAME ORDER BY INDEX_NAME`);
  const [[table]] = await conn.query(
    "SELECT TABLE_COLLATION AS coll FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback'");
  return { cols, keys, coll: table.coll };
}

// The InnoDB tablespace holding feedback: a rebuild moves the table to a new one; an instant ALTER keeps the old one,
// and with it the dropped column's bytes.
async function feedbackSpace(conn) {
  const [[r]] = await conn.query(
    "SELECT SPACE AS space FROM INFORMATION_SCHEMA.INNODB_SYS_TABLES WHERE NAME = CONCAT(DATABASE(), '/feedback')");
  return Number(r.space);
}

test('RJ 504: 0006 drops feedback.ip from a populated table by a rebuild, keeps everything else, and reruns cleanly', { skip }, async (t) => {
  const conn = await freshDatabase(t);
  const dir = realMigrations(t, 5);
  await migrate(conn, { dir, log: quiet });
  for (let i = 1; i <= 30; i++) {
    const anon = i % 3 === 0;
    await conn.query(
      `INSERT INTO feedback (id, received_at, written_at, user_id, username, install_id, ip, build, platform, env, tags,
         message, context, sheet_state, anonymized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dev', ?, ?, ?, ?, ?)`,
      [`22222222-0000-4000-8000-${String(i).padStart(12, '0')}`, `2026-10-14 18:00:00.${String(i).padStart(3, '0')}`,
        i % 2 ? '2026-10-14T17:59:00Z' : null, anon ? null : i, anon ? null : `Pilot_${i}`,
        anon ? null : `6f1c2b8e-0000-4000-8000-${String(i).padStart(12, '0')}`,
        anon ? null : (i === 1 ? '2001:db8::1' : `198.51.100.${i}`), 1000 + i, i % 2 ? 'android' : 'ios', 'bug,idea',
        `note ${i} 🎮 Ünï`, JSON.stringify({ where: 'main_menu', i }), anon ? 'anon_pending' : 'pending',
        anon ? '2026-10-15 00:00:00.000' : null]);
  }
  const [[{ withIp }]] = await conn.query('SELECT COUNT(*) AS withIp FROM feedback WHERE ip IS NOT NULL');
  assert.equal(Number(withIp), 20, 'the measurement: the rows hold addresses before 0006');
  const shapeBefore = await feedbackShape(conn);
  const spaceBefore = await feedbackSpace(conn);
  const [rowsBefore] = await conn.query('SELECT * FROM feedback ORDER BY id');

  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0006_feedback_drop_ip.sql'), path.join(dir, '0006_feedback_drop_ip.sql'));
  assert.deepEqual((await migrate(conn, { dir, log: quiet })).applied, ['0006_feedback_drop_ip.sql']);

  const shape = await feedbackShape(conn);
  assert.deepEqual(shape, { ...shapeBefore, cols: shapeBefore.cols.filter((c) => c.name !== 'ip') }, 'only ip is gone');
  assert.ok(shapeBefore.cols.some((c) => c.name === 'ip') && shape.coll === 'utf8mb4_unicode_ci');
  const [rowsAfter] = await conn.query('SELECT * FROM feedback ORDER BY id');
  assert.deepEqual(rowsAfter, rowsBefore.map(({ ip, ...rest }) => rest), 'every row as it was, but its address');
  const spaceAfter = await feedbackSpace(conn);
  assert.notEqual(spaceAfter, spaceBefore, 'rebuilt into a new tablespace, not dropped instantly');

  await conn.query(fs.readFileSync(path.join(dir, '0006_feedback_drop_ip.sql'), 'utf8'));
  assert.deepEqual(await feedbackShape(conn), shape, 'a rerun changes nothing');
  assert.equal(await feedbackSpace(conn), spaceAfter, 'and rebuilds nothing');

  const { insertFeedback } = require('../src/storage/feedback');
  const r = await insertFeedback({ id: '22222222-0000-4000-8000-000000000099', received_ms: Date.UTC(2026, 9, 20), written_at: null,
    user_id: null, username: null, install_id: null, build: null, platform: null, env: 'dev', tags: [], message: 'after', context: {} }, conn);
  assert.equal(r.duplicate, false, 'the brain writes to the table 0006 leaves');
});
