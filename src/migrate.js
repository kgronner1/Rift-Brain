'use strict';
// Schema migrations: applies migrations/NNNN_name.sql in order and records each in schema_migrations.
//
//   npm run migrate                    apply every pending migration
//   npm run migrate -- --baseline      mark 0001 applied without running it (a database copied from rift_brain)
//   npm run migrate -- --status        list applied and pending, change nothing
//
// The database comes from .env (MYSQL_*), and ENV must be dev, alpha or prod. The legacy rift_brain database is
// never migrated. A migration file must not change once applied (its SHA-256 is recorded), and a new one must
// number above every applied one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const BASELINE_VERSION = 1;
const LEGACY_DATABASE = 'rift_brain';
const LOCK_NAME = 'rift_brain_schema_migrations';
const LOCK_WAIT_SEC = 10;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  checksum CHAR(64) NOT NULL,
  baseline TINYINT(1) NOT NULL DEFAULT 0,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB`;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Every NNNN_name.sql in dir, in version order. Other files (a README) are ignored; a .sql file with a bad name
// or a repeated number is refused, so a typo can never silently skip a migration.
function listMigrations(dir = MIGRATIONS_DIR) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const migrations = [];
  const problems = [];
  for (const file of entries.sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = file.match(FILE_RE);
    if (!m) {
      problems.push(`${file}: not NNNN_lowercase_name.sql`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    migrations.push({ version: Number(m[1]), name: m[2], file, sql, checksum: sha256(sql) });
  }
  const seen = new Map();
  for (const mig of migrations) {
    if (seen.has(mig.version)) problems.push(`${mig.file} and ${seen.get(mig.version)} share a number`);
    seen.set(mig.version, mig.file);
  }
  if (problems.length) throw new Error(`migrations/ is not valid:\n  - ${problems.join('\n  - ')}`);
  return migrations.sort((a, b) => a.version - b.version);
}

// What to do, given the files and the schema_migrations rows. Pure.
// Returns { apply: [migration], mark: [migration], pending: [migration], problems: [string] }.
function planMigrations(migrations, appliedRows, { baseline = false } = {}) {
  const problems = [];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const applied = new Map(appliedRows.map((r) => [Number(r.version), r]));

  for (const [version, row] of applied) {
    const mig = byVersion.get(version);
    if (!mig) {
      problems.push(`migration ${String(version).padStart(4, '0')}_${row.name} is applied but its file is gone`);
    } else if (mig.checksum !== row.checksum) {
      problems.push(`${mig.file} changed after it was applied (recorded ${row.checksum.slice(0, 12)}, file ${mig.checksum.slice(0, 12)}); add a new migration instead`);
    }
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  const maxApplied = applied.size ? Math.max(...applied.keys()) : 0;
  for (const m of pending) {
    if (m.version < maxApplied) {
      problems.push(`${m.file} numbers below an applied migration (${String(maxApplied).padStart(4, '0')}); renumber it`);
    }
  }

  if (baseline) {
    const base = byVersion.get(BASELINE_VERSION);
    if (!base) problems.push('--baseline needs migrations/0001_baseline.sql');
    else if (applied.has(BASELINE_VERSION)) problems.push(`${base.file} is already recorded; nothing to baseline`);
    return { apply: [], mark: base && !applied.has(BASELINE_VERSION) ? [base] : [], pending, problems };
  }
  return { apply: pending, mark: [], pending, problems };
}

// A migration as the batches to send. mysqldump wraps triggers and routines in DELIMITER blocks, which are a
// mysql-client command, not SQL: each statement inside one goes alone; everything else goes as one
// multi-statement batch.
function splitSqlBatches(sql) {
  const batches = [];
  let delimiter = ';';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text && !isOnlyComments(text)) batches.push(text);
    buf = [];
  };
  for (const line of sql.split(/\r?\n/)) {
    const d = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (d) {
      if (delimiter !== ';' && !isOnlyComments(buf.join('\n'))) {
        throw new Error(`a statement before "DELIMITER ${d[1]}" never ends with "${delimiter}"`);
      }
      flush();
      delimiter = d[1];
      continue;
    }
    buf.push(line);
    if (delimiter !== ';') {
      const text = buf.join('\n').trimEnd();
      if (text.endsWith(delimiter)) {
        buf = [text.slice(0, -delimiter.length)];
        flush();
      }
    }
  }
  if (delimiter !== ';' && !isOnlyComments(buf.join('\n'))) {
    throw new Error(`the file ends inside "DELIMITER ${delimiter}"`);
  }
  flush();
  return batches;
}

// True when nothing would run. /*! ... */ is a MySQL executable comment, so it counts as SQL.
function isOnlyComments(text) {
  return text
    .replace(/\/\*(?!!)[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(--|#)/.test(l))
    .join('\n')
    .replace(/;/g, '')
    .trim() === '';
}

async function userTables(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> 'schema_migrations'`
  );
  return rows.map((r) => r.name);
}

// Runs against an open connection made with multipleStatements: true. Returns what it did.
async function migrate(conn, { dir = MIGRATIONS_DIR, baseline = false, status = false, log = console.log } = {}) {
  const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
  if (!db) throw new Error('no database selected (MYSQL_DATABASE)');
  if (db === LEGACY_DATABASE) {
    throw new Error(`refusing to migrate ${LEGACY_DATABASE}: the legacy brain's database stays as it is until cutover`);
  }

  const migrations = listMigrations(dir);

  const [[lock]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, LOCK_WAIT_SEC]);
  if (Number(lock.got) !== 1) throw new Error(`another migrate holds ${LOCK_NAME} on ${db}`);
  try {
    await conn.query(CREATE_TABLE);
    const [appliedRows] = await conn.query('SELECT version, name, checksum, baseline FROM schema_migrations ORDER BY version');
    const plan = planMigrations(migrations, appliedRows, { baseline });

    if (status) {
      for (const r of appliedRows) {
        log(`applied  ${String(r.version).padStart(4, '0')}_${r.name}${Number(r.baseline) ? ' (baseline)' : ''}`);
      }
      for (const m of plan.pending) log(`pending  ${m.file}`);
      for (const p of plan.problems) log(`PROBLEM  ${p}`);
      return { applied: [], marked: [], problems: plan.problems };
    }
    if (plan.problems.length) throw new Error(`nothing done:\n  - ${plan.problems.join('\n  - ')}`);

    const tables = await userTables(conn);
    if (baseline && tables.length === 0) {
      throw new Error(`${db} has no tables to baseline; run plain migrate to build it from 0001`);
    }
    if (plan.apply.some((m) => m.version === BASELINE_VERSION) && tables.length > 0) {
      throw new Error(`${db} already has tables (${tables.slice(0, 5).join(', ')}${tables.length > 5 ? ', ...' : ''}); `
        + 'if it is a copy of rift_brain, run migrate --baseline first');
    }

    for (const m of plan.mark) {
      await conn.query('INSERT INTO schema_migrations (version, name, checksum, baseline) VALUES (?, ?, ?, 1)',
        [m.version, m.name, m.checksum]);
      log(`marked   ${m.file} as applied (baseline, not run)`);
    }
    for (const m of plan.apply) {
      log(`applying ${m.file}`);
      for (const batch of splitSqlBatches(m.sql)) {
        try {
          await conn.query(batch);
        } catch (err) {
          throw new Error(`${m.file} failed, and is not recorded (DDL is not transactional: check what it did): ${err.message}`);
        }
      }
      await conn.query('INSERT INTO schema_migrations (version, name, checksum, baseline) VALUES (?, ?, ?, 0)',
        [m.version, m.name, m.checksum]);
    }
    if (!plan.mark.length && !plan.apply.length) log(`${db} is up to date`);
    return { applied: plan.apply.map((m) => m.file), marked: plan.mark.map((m) => m.file), problems: [] };
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
  }
}

function parseArgs(argv) {
  const opts = { baseline: false, status: false, dir: MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') opts.baseline = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--dir') opts.dir = path.resolve(argv[++i] || '');
    else throw new Error(`unknown argument "${a}" (use --baseline, --status, --dir <path>)`);
  }
  if (opts.baseline && opts.status) throw new Error('--baseline and --status do not go together');
  return opts;
}

async function main(argv) {
  require('dotenv').config();
  const { loadMysqlEnv } = require('./config/env');
  const mysql = require('mysql2/promise');

  const opts = parseArgs(argv);
  const env = String(process.env.ENV || '').trim();
  if (!['dev', 'alpha', 'prod'].includes(env)) {
    throw new Error(`runs only with ENV=dev, alpha or prod in .env (got "${env || 'unset'}": the legacy brain)`);
  }
  const conn = await mysql.createConnection({ ...loadMysqlEnv(process.env), multipleStatements: true });
  try {
    await migrate(conn, opts);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`migrate: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  listMigrations,
  planMigrations,
  splitSqlBatches,
  isOnlyComments,
  parseArgs,
  migrate,
  sha256,
  MIGRATIONS_DIR,
  BASELINE_VERSION,
  LEGACY_DATABASE,
};
