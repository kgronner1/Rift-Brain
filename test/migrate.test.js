'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listMigrations, planMigrations, splitSqlBatches, isOnlyComments, parseArgs, sha256, MIGRATIONS_DIR,
} = require('../src/migrate');

function tempDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

function mig(version, name, sql = `-- ${name}\nDO ${version};\n`) {
  return { version, name, file: `${String(version).padStart(4, '0')}_${name}.sql`, sql, checksum: sha256(sql) };
}

function row(m, baseline = 0) {
  return { version: m.version, name: m.name, checksum: m.checksum, baseline };
}

test('the shipped migrations directory is valid, and 0002 is there', () => {
  const files = listMigrations(MIGRATIONS_DIR).map((m) => m.file);
  assert.ok(files.includes('0002_hardening.sql'), files.join(', '));
  for (const m of listMigrations(MIGRATIONS_DIR)) assert.ok(splitSqlBatches(m.sql).length > 0, m.file);
});

test('listMigrations sorts, ignores non-sql files and refuses bad names and repeated numbers', (t) => {
  const dir = tempDir(t, { '0002_b.sql': 'DO 2;', '0001_a.sql': 'DO 1;', 'README.md': '#' });
  assert.deepEqual(listMigrations(dir).map((m) => m.file), ['0001_a.sql', '0002_b.sql']);
  assert.deepEqual(listMigrations(path.join(dir, 'missing')), []);

  const bad = tempDir(t, { '0001_a.sql': 'DO 1;', '0001_b.sql': 'DO 1;', '2_c.sql': 'DO 2;', '0003_Up.sql': '' });
  assert.throws(() => listMigrations(bad), (err) => {
    assert.match(err.message, /0001_b\.sql and 0001_a\.sql share a number/);
    assert.match(err.message, /2_c\.sql: not NNNN_lowercase_name\.sql/);
    assert.match(err.message, /0003_Up\.sql: not NNNN/);
    return true;
  });
});

test('a fresh database applies everything in order', () => {
  const a = mig(1, 'baseline');
  const b = mig(2, 'hardening');
  const plan = planMigrations([a, b], []);
  assert.deepEqual(plan.apply.map((m) => m.version), [1, 2]);
  assert.deepEqual(plan.problems, []);
});

test('an up-to-date database applies nothing; a new file applies alone', () => {
  const a = mig(1, 'baseline');
  const b = mig(2, 'hardening');
  assert.deepEqual(planMigrations([a, b], [row(a), row(b)]).apply, []);
  const c = mig(3, 'next');
  assert.deepEqual(planMigrations([a, b, c], [row(a, 1), row(b)]).apply.map((m) => m.version), [3]);
});

test('--baseline marks 0001 only, and only once', () => {
  const a = mig(1, 'baseline');
  const b = mig(2, 'hardening');
  const plan = planMigrations([a, b], [], { baseline: true });
  assert.deepEqual(plan.mark.map((m) => m.version), [1]);
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.problems, []);

  assert.match(planMigrations([a, b], [row(a, 1)], { baseline: true }).problems[0], /already recorded/);
  assert.match(planMigrations([b], [], { baseline: true }).problems[0], /needs migrations\/0001_baseline\.sql/);
});

test('a changed, vanished or out-of-order migration stops everything', () => {
  const a = mig(1, 'baseline');
  const b = mig(2, 'hardening');
  const edited = { ...row(b), checksum: sha256('something else') };
  assert.match(planMigrations([a, b], [row(a), edited]).problems.join('\n'), /0002_hardening\.sql changed after it was applied/);
  assert.match(planMigrations([a], [row(a), row(b)]).problems.join('\n'), /0002_hardening is applied but its file is gone/);
  const late = mig(2, 'late');
  const c = mig(3, 'c');
  assert.match(planMigrations([a, late, c], [row(a), row(c)]).problems.join('\n'), /0002_late\.sql numbers below an applied migration \(0003\)/);
});

test('plain SQL is one batch; a DELIMITER block is split into its statements', () => {
  assert.deepEqual(splitSqlBatches('-- note\nCREATE TABLE a (x INT);\nCREATE TABLE b (y INT);\n'),
    ['-- note\nCREATE TABLE a (x INT);\nCREATE TABLE b (y INT);']);

  const dump = [
    '/*M!999999\\- enable the sandbox mode */',
    '/*!40101 SET NAMES utf8mb4 */;',
    'CREATE TABLE t (x INT);',
    'DELIMITER ;;',
    '/*!50003 CREATE*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN',
    '  SET NEW.x = 1;',
    'END */;;',
    'DELIMITER ;',
    '/*!40101 SET character_set_client = @saved_cs_client */;',
    '',
  ].join('\n');
  assert.deepEqual(splitSqlBatches(dump), [
    '/*M!999999\\- enable the sandbox mode */\n/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE t (x INT);',
    '/*!50003 CREATE*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN\n  SET NEW.x = 1;\nEND */',
    '/*!40101 SET character_set_client = @saved_cs_client */;',
  ]);

  assert.throws(() => splitSqlBatches('DELIMITER ;;\nCREATE TRIGGER x BEGIN END\n'), /ends inside "DELIMITER ;;"/);
  assert.deepEqual(splitSqlBatches('-- only a comment\n/* and another */\n'), []);
});

test('executable comments count as SQL', () => {
  assert.equal(isOnlyComments('-- x\n# y\n/* z */;'), true);
  assert.equal(isOnlyComments('/*!40101 SET NAMES utf8 */;'), false);
});

test('arguments', () => {
  assert.deepEqual(parseArgs([]), { baseline: false, status: false, dir: MIGRATIONS_DIR });
  assert.equal(parseArgs(['--baseline']).baseline, true);
  assert.equal(parseArgs(['--dir', 'x']).dir, path.resolve('x'));
  assert.throws(() => parseArgs(['--force']), /unknown argument "--force"/);
  assert.throws(() => parseArgs(['--baseline', '--status']), /do not go together/);
});

// A stand-in connection: enough of mysql2's query() for migrate()'s control flow. The SQL itself is
// exercised by migrate.db.test.js against a real server.
function fakeConn({ db = 'rj_dev', tables = [], applied = [], lock = 1, failOn = null } = {}) {
  const sent = [];
  const rows = [...applied];
  return {
    sent,
    rows,
    async query(sql, params = []) {
      sent.push(sql.trim().split('\n')[0]);
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      if (sql.startsWith('SELECT DATABASE()')) return [[{ db }]];
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ got: lock }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{}]];
      if (sql.startsWith('SELECT version')) return [rows];
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [tables.map((name) => ({ name }))];
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        rows.push({ version: params[0], name: params[1], checksum: params[2], baseline: sql.includes('?, 1)') ? 1 : 0 });
      }
      return [[]];
    },
  };
}

test('migrate() refuses rift_brain and a held lock, and always releases its lock', async (t) => {
  const { migrate } = require('../src/migrate');
  const dir = tempDir(t, { '0001_baseline.sql': 'CREATE TABLE a (x INT);', '0002_next.sql': 'CREATE TABLE b (x INT);' });
  await assert.rejects(migrate(fakeConn({ db: 'rift_brain' }), { dir, log: () => {} }), /refusing to migrate rift_brain/);
  await assert.rejects(migrate(fakeConn({ lock: 0 }), { dir, log: () => {} }), /another migrate holds/);

  const failing = fakeConn({ failOn: 'CREATE TABLE b' });
  await assert.rejects(migrate(failing, { dir, log: () => {} }), /0002_next\.sql failed, and is not recorded/);
  assert.deepEqual(failing.rows.map((r) => r.version), [1]);
  assert.equal(failing.sent.at(-1), 'SELECT RELEASE_LOCK(?)');
});

test('migrate() applies in order and records, baselines only a database with tables', async (t) => {
  const { migrate } = require('../src/migrate');
  const dir = tempDir(t, { '0001_baseline.sql': 'CREATE TABLE a (x INT);', '0002_next.sql': 'CREATE TABLE b (x INT);' });
  const fresh = fakeConn();
  assert.deepEqual((await migrate(fresh, { dir, log: () => {} })).applied, ['0001_baseline.sql', '0002_next.sql']);
  assert.deepEqual(fresh.rows.map((r) => [r.version, r.baseline]), [[1, 0], [2, 0]]);

  await assert.rejects(migrate(fakeConn({ tables: ['users'] }), { dir, log: () => {} }), /already has tables \(users\)/);
  await assert.rejects(migrate(fakeConn(), { dir, baseline: true, log: () => {} }), /no tables to baseline/);
  const copy = fakeConn({ tables: ['users'] });
  assert.deepEqual((await migrate(copy, { dir, baseline: true, log: () => {} })).marked, ['0001_baseline.sql']);
  assert.deepEqual(copy.rows.map((r) => [r.version, r.baseline]), [[1, 1]]);
  assert.deepEqual((await migrate(copy, { dir, log: () => {} })).applied, ['0002_next.sql']);
});
