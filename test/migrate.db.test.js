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
