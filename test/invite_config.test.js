'use strict';
// RJ 458's settings: flags.invites in both remote config readers and both sources, JOIN_URL_BASE and FOLLOW_WINDOW_SEC
// in the environment, the invite id's alphabet, and the hourly sweep of expired invites over a stand-in store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateDocument, FLAG_NAMES } = require('../src/config/remoteSchema');
const { mergeDocument, defaultView } = require('../src/config/remote');
const { loadEnv } = require('../src/config/env');
const { newInviteId, normalizeInviteId, INVITE_ALPHABET } = require('../src/storage/invites');
const { createInviteSweep } = require('../src/invites/sweep');
const { loggedPath } = require('../src/middleware/requestId');
const { quietLogger } = require('./match_fixture');

const good = (env) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', `${env}.client.v1.json`), 'utf8'));
const NEW_ENV = {
  ENV: 'dev', MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'd', PUBLIC_PORT: '3001',
  INTERNAL_PORT: '3101', GAME_PORTS: '8100-8104', SERVERS_DIR: '/opt/rj/dev/servers', GAME_HOST: 'play.example.test',
  SESSION_KEY: '1a'.repeat(32), JOIN_KEY: '2b'.repeat(32), LOBBY_MASTER_KEY: '3c'.repeat(32),
};

test('flags.invites: in both sources and the compiled defaults, true', () => {
  assert.ok(FLAG_NAMES.includes('invites'));
  for (const env of ['dev', 'alpha']) {
    const d = good(env);
    assert.equal(d.flags.invites, true, env);
    assert.deepEqual(validateDocument(d, { env }).problems, [], env);
  }
  assert.equal(defaultView('dev').flags.invites, true);
});

test('flags.invites: the strict check requires a boolean; the tolerant reader keeps the default, then the last good value', () => {
  const at = (fn) => {
    const d = good('dev');
    fn(d);
    return validateDocument(d, { env: 'dev' }).problems;
  };
  assert.deepEqual(at((d) => { delete d.flags.invites; }), ['flags.invites: is missing']);
  assert.match(at((d) => { d.flags.invites = 'yes'; })[0], /^flags\.invites: must be true or false/);
  assert.deepEqual(at((d) => { d.flags.invites = false; }), []);

  const old = good('dev');
  delete old.flags.invites;
  const a = mergeDocument(defaultView('dev'), old);
  assert.deepEqual([a.rejected, a.view.flags.invites], [[], true], 'a document from before RJ 458');
  const next = good('dev');
  next.flags.invites = false;
  const b = mergeDocument(a.view, next);
  assert.equal(b.view.flags.invites, false);
  next.flags.invites = 0;
  const c = mergeDocument(b.view, next);
  assert.deepEqual([c.view.flags.invites, c.rejected], [false, ['flags.invites: must be true or false']]);
});

test('JOIN_URL_BASE: dev and alpha default to the link domain; set, an https base without a trailing slash; bad, no boot', () => {
  assert.equal(loadEnv(NEW_ENV).JOIN_URL_BASE, 'https://join.riftjumpers.space/dev');
  assert.equal(loadEnv({ ...NEW_ENV, ENV: 'alpha' }).JOIN_URL_BASE, 'https://join.riftjumpers.space');
  assert.equal(loadEnv({ ...NEW_ENV, ENV: 'prod' }).JOIN_URL_BASE, null);
  assert.equal(loadEnv({ MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'd' }).JOIN_URL_BASE, null, 'legacy');
  assert.equal(loadEnv({ ...NEW_ENV, JOIN_URL_BASE: ' https://join.example.test/x/ ' }).JOIN_URL_BASE, 'https://join.example.test/x');
  for (const bad of ['http://join.riftjumpers.space', 'join.riftjumpers.space', 'https://join.riftjumpers.space/?a=1',
    'https://u:p@join.riftjumpers.space', 'https://join.riftjumpers.space/#x']) {
    assert.throws(() => loadEnv({ ...NEW_ENV, JOIN_URL_BASE: bad }), /JOIN_URL_BASE/, bad);
  }
});

test('FOLLOW_WINDOW_SEC: 600 unless set; 1..86400', () => {
  assert.equal(loadEnv(NEW_ENV).FOLLOW_WINDOW_SEC, 600);
  assert.equal(loadEnv({ ...NEW_ENV, FOLLOW_WINDOW_SEC: '20' }).FOLLOW_WINDOW_SEC, 20);
  for (const bad of ['0', '-5', '1.5', '86401', 'ten']) {
    assert.throws(() => loadEnv({ ...NEW_ENV, FOLLOW_WINDOW_SEC: bad }), /FOLLOW_WINDOW_SEC must be a whole number of seconds/, bad);
  }
});

test('invite ids: 10 characters of the alphabet without 0/1/i/l/o, from the CSPRNG; a link\'s id is read case-blind', () => {
  assert.equal(INVITE_ALPHABET, '23456789abcdefghjkmnpqrstuvwxyz');
  assert.equal(INVITE_ALPHABET.length, 31);
  for (const c of '01ilo') assert.ok(!INVITE_ALPHABET.includes(c), c);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = newInviteId();
    assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 2000);
  const every = new Set([...Array.from({ length: 300 }, () => newInviteId()).join('')]);
  assert.equal(every.size, 31, 'every character of the alphabet turns up');
  assert.equal(newInviteId(() => 0), '2222222222');
  assert.equal(newInviteId((n) => n - 1), 'zzzzzzzzzz');
  assert.equal(normalizeInviteId(' AB23CD45EF '), 'ab23cd45ef');
  for (const bad of [null, 12, '', 'ab23cd45e', 'ab23cd45efg', 'ab23cd45e0', 'ab23cd45el', 'ab23-d45ef']) {
    assert.equal(normalizeInviteId(bad), null, String(bad));
  }
});

test('the request log shows /v1/invites/:id, never the id', () => {
  assert.equal(loggedPath('/v1/invites/ab23cd45ef'), '/v1/invites/:id');
  assert.equal(loggedPath('/v1/invites/ab23cd45ef/x'), '/v1/invites/:id/x');
  assert.equal(loggedPath('/v1/me/invites'), '/v1/me/invites');
  assert.equal(loggedPath('/v1/match/join'), '/v1/match/join');
});

test('the invite sweep: deletes through the store at its clock, logs only when it deleted, never overlaps, survives a failure', async (t) => {
  const calls = [];
  let release;
  const store = {
    result: 3,
    async sweepExpiredInvites(q) {
      calls.push(q);
      if (this.hold) await new Promise((r) => { release = r; });
      if (this.fail) throw new Error('database down');
      return this.result;
    },
  };
  const logger = quietLogger();
  const s = createInviteSweep({ store, logger, now: () => 1234, firstMs: 10, everyMs: 20 });
  assert.deepEqual(await s.sweep(), { deleted: 3 });
  assert.deepEqual(calls, [{ now: 1234 }]);
  assert.deepEqual(logger.lines, ['[invites] swept 3 expired invite(s)']);
  store.result = 0;
  assert.deepEqual(await s.sweep(), { deleted: 0 });
  assert.equal(logger.lines.length, 1, 'nothing deleted, nothing logged');
  store.hold = true;
  const first = s.sweep();
  assert.deepEqual(await s.sweep(), { skipped: true });
  release();
  await first;
  store.hold = false;
  store.fail = true;
  assert.deepEqual(await s.sweep(), { failed: true });
  assert.match(logger.lines.at(-1), /\[invites\] sweep failed: .*database down/);

  store.fail = false;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timed = createInviteSweep({ store, logger, firstMs: 300000, everyMs: 3600000 });
  timed.start();
  const before = calls.length;
  t.mock.timers.tick(299999);
  assert.equal(calls.length, before);
  t.mock.timers.tick(1);
  assert.equal(calls.length, before + 1, 'the first sweep');
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(3600000);
  assert.equal(calls.length, before + 2, 'then hourly');
  timed.stop();
});
