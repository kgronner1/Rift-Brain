'use strict';
// RJ 511: every table a migration makes, and every users column, is one ops/db/scrub_snapshot.sh names ("Every
// table"). The scrub itself stops on anything it does not name, against the database (ops/db/test/scrub_snapshot.sh);
// this finds it in the change that adds the migration, without one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listMigrations } = require('../src/migrate');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'ops', 'db', 'scrub_snapshot.sh'), 'utf8');

function scriptList(name) {
  const m = SCRIPT.match(new RegExp(`^${name}="([^"]*)"$`, 'm'));
  assert.ok(m, `scrub_snapshot.sh sets ${name}`);
  return m[1].split(/\s+/).filter(Boolean);
}

function withoutComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

// Table names in CREATE TABLE, whether a migration runs it or builds it in a string for PREPARE (0002).
function createdTables(sql) {
  return [...withoutComments(sql).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1]);
}

// Columns given to users: 0001's CREATE TABLE body, and each ALTER TABLE users ... ADD [COLUMN] after it.
function usersColumns(text) {
  const sql = withoutComments(text);
  const cols = [];
  const body = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?users`?\s*\(([\s\S]*?)\n\)/i);
  if (body) {
    for (const line of body[1].split('\n')) {
      const m = line.match(/^\s*`?(\w+)`?\s+(?!KEY\b)\w/);
      if (m && !/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|CHECK)$/i.test(m[1])) cols.push(m[1]);
    }
  }
  for (const stmt of sql.split(';')) {
    if (!/ALTER\s+TABLE\s+`?users`?\s/i.test(stmt)) continue;
    const adds = stmt.matchAll(
      /\bADD\s+(?!(?:UNIQUE|KEY|INDEX|CONSTRAINT|PRIMARY|FOREIGN|FULLTEXT|SPATIAL|CHECK)\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi,
    );
    for (const m of adds) cols.push(m[1]);
  }
  return cols;
}

test('every table a migration creates is one scrub_snapshot.sh names', () => {
  const named = new Set(['users', ...scriptList('EMPTY_TABLES'), ...scriptList('KEEP_TABLES')]);
  const created = new Set(['schema_migrations']); // src/migrate.js makes it
  for (const m of listMigrations()) for (const t of createdTables(m.sql)) created.add(t);
  for (const t of ['users', 'user_stats', 'user_credentials', 'feedback']) {
    assert.ok(created.has(t), `control: the pattern finds ${t} in migrations/`);
  }
  const unnamed = [...created].filter((t) => !named.has(t));
  assert.deepEqual(unnamed, [], `name each in ops/db/scrub_snapshot.sh ("Every table") with what the scrub does to it`);
});

test('every users column a migration adds is one scrub_snapshot.sh names', () => {
  const named = new Set(scriptList('USERS_COLUMNS'));
  const added = new Set();
  for (const m of listMigrations()) for (const c of usersColumns(m.sql)) added.add(c);
  for (const c of ['username', 'email', 'access_token', 'is_guest']) {
    assert.ok(added.has(c), `control: the patterns find users.${c} in migrations/`);
  }
  const unnamed = [...added].filter((c) => !named.has(c));
  assert.deepEqual(unnamed, [], 'scrub each in the users step of ops/db/scrub_snapshot.sh, then name it in USERS_COLUMNS');
});

test('the parsers see a new table and a new users column', () => {
  assert.deepEqual(createdTables("SET @sql := 'CREATE TABLE IF NOT EXISTS player_notes (id INT)';"), ['player_notes']);
  assert.deepEqual(usersColumns('ALTER TABLE users ADD COLUMN phone VARCHAR(32), ADD KEY ix (phone);'), ['phone']);
  assert.deepEqual(usersColumns('ALTER TABLE `users` ADD UNIQUE KEY uq (email); ALTER TABLE user_stats ADD x INT;'), []);
});
