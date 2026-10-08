'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateDocument, newLocks, stamp, diffDocuments, floorFor, CLAMPS } = require('../src/config/remoteSchema');

const ROOT = path.join(__dirname, '..');
const SOURCE = (env) => path.join(ROOT, 'config', `${env}.client.v1.json`);
const good = (env = 'dev') => JSON.parse(fs.readFileSync(SOURCE(env), 'utf8'));

function problemsOf(doc, env = 'dev') {
  return validateDocument(doc, { env }).problems;
}

function withChange(fn, env = 'dev') {
  const doc = good(env);
  fn(doc);
  return doc;
}

test('the checked-in sources are valid for their own environment, and only for it', () => {
  for (const env of ['dev', 'alpha']) {
    assert.deepEqual(problemsOf(good(env), env), [], env);
  }
  assert.match(problemsOf(good('dev'), 'alpha').join('\n'), /^env: is "dev" but the document is published as alpha/m);
  assert.match(problemsOf(good('alpha'), 'dev').join('\n'), /^env: is "alpha"/m);
  assert.equal(good('dev').endpoints.api, 'https://api-dev.riftjumpers.space');
  assert.equal(good('alpha').endpoints.api, 'https://api.riftjumpers.space');
});

test('every clamp holds at both ends and refuses one past either', () => {
  for (const [p, [lo, hi]] of Object.entries(CLAMPS)) {
    const set = (doc, v) => {
      const keys = p.split('.');
      let o = doc;
      for (const k of keys.slice(0, -1)) o = o[k];
      o[keys[keys.length - 1]] = v;
    };
    // cap_ms must also stay >= base_ms; keep base at its floor so cap's own clamp is what is tested.
    const prep = (doc) => { if (p === 'tunables.backoff.cap_ms') doc.tunables.backoff.base_ms = 250; };
    for (const v of [lo, hi]) {
      assert.deepEqual(problemsOf(withChange((d) => { prep(d); set(d, v); })), [], `${p}=${v}`);
    }
    for (const v of [lo - 1, hi + 1]) {
      const probs = problemsOf(withChange((d) => { prep(d); set(d, v); }));
      assert.equal(probs.length, 1, `${p}=${v}: ${probs}`);
      assert.ok(probs[0].startsWith(`${p}: must be at`), probs[0]);
    }
    assert.match(problemsOf(withChange((d) => { prep(d); set(d, String(lo)); }))[0], new RegExp(`^${p.replace(/\./g, '\\.')}: must be an integer`));
    assert.match(problemsOf(withChange((d) => { prep(d); set(d, lo + 0.5); }))[0], /must be an integer/);
  }
});

test('backoff cap below base is refused', () => {
  const probs = problemsOf(withChange((d) => { d.tunables.backoff = { base_ms: 20000, cap_ms: 10000 }; }));
  assert.deepEqual(probs, ['tunables.backoff.cap_ms: must be at least base_ms (20000), got 10000']);
});

test('endpoints.api must be https on our own domain, a bare origin', () => {
  for (const bad of ['http://api.riftjumpers.space', 'https://api.riftjumpers.space.evil.com', 'https://evilriftjumpers.space',
    'https://riftjumpers.space', 'https://127.0.0.1', 'http://localhost:3000', 'https://user:pw@api.riftjumpers.space',
    'https://api.riftjumpers.space/v1', 'api.riftjumpers.space', 7]) {
    const probs = problemsOf(withChange((d) => { d.endpoints.api = bad; }));
    assert.equal(probs.length, 1, `${bad}: ${probs}`);
    assert.match(probs[0], /^endpoints\.api: must be/);
  }
  assert.deepEqual(problemsOf(withChange((d) => { d.endpoints.api = 'https://api-dev.riftjumpers.space/'; })), []);
});

test('unknown and missing fields are refused, so a typo cannot publish', () => {
  assert.deepEqual(problemsOf(withChange((d) => { d.ttl_secs = 300; })), ['ttl_secs: is not a schema 1 field (a typo?)']);
  assert.deepEqual(problemsOf(withChange((d) => { delete d.flags.quickplay; })), ['flags.quickplay: is missing']);
  assert.deepEqual(problemsOf(withChange((d) => { d.gates.min_build.desktop = 3; })),
    ['gates.min_build.desktop: is not a platform (default, android, ios)']);
  assert.deepEqual(problemsOf(withChange((d) => { delete d.gates.min_build.ios; })), [], 'a platform may fall back to default');
  assert.deepEqual(problemsOf(withChange((d) => { delete d.gates.min_build.default; })), ['gates.min_build.default: is missing']);
});

test('types: booleans, enums, strings, times', () => {
  const cases = [
    [(d) => { d.flags.multiplayer = 'true'; }, /^flags\.multiplayer: must be true or false/],
    [(d) => { d.gates.maintenance.scope = 'everything'; }, /^gates\.maintenance\.scope: must be one of multiplayer, app/],
    [(d) => { d.gates.maintenance.ends_at = '2026-10-02 18:00'; }, /^gates\.maintenance\.ends_at: must be null or an ISO/],
    [(d) => { d.published_at = 'yesterday'; }, /^published_at: must be an ISO 8601 UTC time/],
    [(d) => { d.schema = 2; }, /^schema: must be 1/],
    [(d) => { d.serial = -1; }, /^serial: must be at least 0/],
    [(d) => { d.notice.level = 'shout'; }, /^notice\.level: must be one of/],
    [(d) => { d.links.store.android = 'http://play.google.com/x'; }, /^links\.store\.android: must be an https:\/\/ URL/],
    [(d) => { d.notice.url = 'javascript:alert(1)'; }, /^notice\.url: must be an https:\/\/ URL/],
    [(d) => { d.gates.maintenance.message = 'word '.repeat(56) + 'x'; }, /^gates\.maintenance\.message: must be at most 280/],
    [(d) => { d.server.lobby_queue_max = -5; }, /^server\.lobby_queue_max: must be at least 0/],
    [(d) => { d.endpoints = []; }, /^endpoints: must be an object, got an array/],
  ];
  for (const [fn, re] of cases) {
    const probs = problemsOf(withChange(fn));
    assert.equal(probs.length, 1, `${re}: ${probs}`);
    assert.match(probs[0], re);
  }
  assert.deepEqual(problemsOf(withChange((d) => { d.gates.maintenance.ends_at = '2026-10-02T18:00:00Z'; })), []);
});

test('active maintenance and a notice must say something', () => {
  assert.deepEqual(problemsOf(withChange((d) => { d.gates.maintenance.active = true; })),
    ['gates.maintenance.message: is empty while maintenance is active: players would see a blank lock']);
  assert.deepEqual(problemsOf(withChange((d) => { d.notice.id = 'n1'; })),
    ['notice.message: is empty but notice.id is "n1": players would see a blank notice']);
});

test('messages overrides: codes, shape and action vocabulary', () => {
  assert.deepEqual(problemsOf(withChange((d) => {
    d.messages = { NET_UNREACHABLE: { message: 'No signal out here.' },
      LOBBY_FULL: { title: 'Full', message: 'That lobby is full.', action: { kind: 'retry', label: 'Again' } } };
  })), []);
  const probs = problemsOf(withChange((d) => {
    d.messages = { lobby_full: { message: 'x' }, A: { message: '' }, B: { message: 'x', action: { kind: 'explode' } },
      C: { message: 'x', action: { kind: 'open_url' } }, D: { message: 'x', colour: 'red' } };
  }));
  assert.deepEqual(probs.sort(), [
    'messages.A.message: is empty',
    'messages.B.action.kind: must be one of dismiss, retry, open_url, open_store, login, got "explode"',
    'messages.C.action.url: is required by open_url',
    'messages.D.colour: is not a message field (title, message, action)',
    'messages.lobby_full: is not an error code (UPPER_SNAKE_CASE)',
  ]);
});

test('a string that looks like a secret is refused; ordinary URLs are not', () => {
  for (const s of ['ab'.repeat(32), 'AKIAIOSFODNN7EXAMPLE', '-----BEGIN RSA PRIVATE KEY-----', 'k'.repeat(48)]) {
    const probs = problemsOf(withChange((d) => { d.notice.id = 'n'; d.notice.message = s; }));
    assert.equal(probs.length, 1, s);
    assert.match(probs[0], /looks like it holds a key or secret/);
  }
  assert.deepEqual(problemsOf(withChange((d) => {
    d.links.store.android = 'https://play.google.com/store/apps/details?id=com.riftjumpers.game&hl=en_US_with_a_long_tail_abcdefghijklmnop';
  })), []);
});

test('not a JSON object at all', () => {
  assert.deepEqual(problemsOf(null), ['(document): must be an object, got null']);
  assert.deepEqual(problemsOf([1]), ['(document): must be an object, got an array']);
});

test('floors: the platform key, then default', () => {
  assert.equal(floorFor({ default: 5, android: 9 }, 'android'), 9);
  assert.equal(floorFor({ default: 5, android: 9 }, 'ios'), 5);
  assert.equal(floorFor(undefined, 'ios'), 0);
});

test('the lock guard names what a raised floor or app maintenance locks, and nothing else', () => {
  const live = good();
  assert.deepEqual(newLocks(live, good()), []);
  assert.deepEqual(newLocks(null, good()), [], 'the first publish of the template locks nobody');

  // ios is spelled out as 0 in the source, so raising default does not reach it.
  const raised = withChange((d) => { d.gates.min_build.default = 100; d.gates.min_build.android = 120; });
  assert.deepEqual(newLocks(live, raised).map((l) => l.text), [
    'gates.min_build android: 0 -> 120: android builds 0..119 can no longer open the app',
    'gates.min_build default: 0 -> 100: builds on any other platform 0..99 can no longer open the app',
  ]);
  assert.deepEqual(newLocks(raised, live), [], 'lowering a floor locks nobody');

  const mp = withChange((d) => { d.gates.min_build_multiplayer.ios = 7; d.gates.min_wire = 3; });
  assert.deepEqual(newLocks(live, mp).map((l) => l.text), [
    'gates.min_build_multiplayer ios: 0 -> 7: ios builds 0..6 can no longer play online',
    'gates.min_wire: 1 -> 3: every build on wire 1..2 can no longer play online',
  ]);

  const mpMaint = withChange((d) => { d.gates.maintenance = { active: true, scope: 'multiplayer', title: '', message: 'x', ends_at: null }; });
  assert.deepEqual(newLocks(live, mpMaint), [], 'multiplayer maintenance is not a lock (single player stays)');
  const appMaint = withChange((d) => { d.gates.maintenance = { active: true, scope: 'app', title: '', message: 'x', ends_at: null }; });
  assert.equal(newLocks(live, appMaint).length, 1);
  assert.equal(newLocks(mpMaint, appMaint).length, 1, 'widening multiplayer to app is a lock');
  assert.deepEqual(newLocks(appMaint, appMaint), [], 'already locked');
});

test('stamp sets serial and a second-precision UTC time; diff ignores the stamp', () => {
  const s = stamp(good(), { serial: 42, now: new Date('2026-10-07T12:34:56.789Z') });
  assert.equal(s.serial, 42);
  assert.equal(s.published_at, '2026-10-07T12:34:56Z');
  assert.deepEqual(validateDocument(s, { env: 'dev' }).problems, []);
  assert.deepEqual(diffDocuments(good(), s), []);
  assert.deepEqual(diffDocuments(good(), withChange((d) => { d.ttl_sec = 600; d.messages.X = { message: 'y' }; })),
    ['messages.X: (absent) -> {"message":"y"}', 'ttl_sec: 300 -> 600']);
});

// --- the scripts, end to end, against a local root (no AWS) -------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...opts.env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('validate.mjs: exit 0 on a good document, 1 with every problem on a bad one, 2 on bad usage', (t) => {
  const dir = tmp(t);
  assert.equal(run('node', ['ops/config/validate.mjs', 'config/dev.client.v1.json', '--env', 'dev']).code, 0);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify(withChange((d) => { d.ttl_sec = 5; d.endpoints.api = 'https://evil.example'; })));
  const r = run('node', ['ops/config/validate.mjs', bad, '--env', 'dev']);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL .*2 problems/);
  assert.match(r.out, /ttl_sec: must be at least 60, got 5/);
  assert.match(r.out, /endpoints\.api: must be https/);
  fs.writeFileSync(bad, '{ not json');
  assert.equal(run('node', ['ops/config/validate.mjs', bad, '--env', 'dev']).code, 1);
  assert.equal(run('node', ['ops/config/validate.mjs', 'config/dev.client.v1.json']).code, 2);
  assert.equal(run('node', ['ops/config/validate.mjs', 'config/dev.client.v1.json', '--env', 'staging']).code, 2);
});

test('publish.sh and rollback.sh against a local root: serials, the lock guard, the dry run', (t) => {
  const root = tmp(t);
  const live = path.join(root, 'dev', 'client.v1.json');
  const pub = (...a) => run('bash', ['ops/config/publish.sh', 'dev', '--local-root', root, '--skip-client-check', ...a]);
  const serial = () => JSON.parse(fs.readFileSync(live, 'utf8')).serial;

  // Without --skip-client-check and no Wobble Planet checker, it refuses before writing anything.
  const noChecker = run('bash', ['ops/config/publish.sh', 'dev', '--local-root', root], { env: { RJ_WOBBLE_PLANET: root } });
  assert.equal(noChecker.code, 1);
  assert.match(noChecker.out, /check_remote_config\.gd does not exist/);
  assert.equal(fs.existsSync(live), false);

  // A dry run writes nothing.
  const dry = pub('--dry-run');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /DRY RUN: nothing written/);
  assert.equal(fs.existsSync(live), false);

  let r = pub();
  assert.equal(r.code, 0, r.out);
  assert.equal(serial(), 1);
  r = pub();
  assert.equal(r.code, 0, r.out);
  assert.equal(serial(), 2, 'a re-run publishes the same content under the next serial');

  // A wrong-env document is refused.
  r = run('bash', ['ops/config/publish.sh', 'dev', '--local-root', root, '--skip-client-check', '--file', 'config/alpha.client.v1.json']);
  assert.equal(r.code, 1);
  assert.match(r.out, /env: is "alpha" but the document is published as dev/);
  assert.equal(serial(), 2);

  // The lock guard refuses a raised floor without --confirm-lock, and says which builds.
  const raised = path.join(root, 'raised.json');
  fs.writeFileSync(raised, JSON.stringify(withChange((d) => { d.gates.min_build_multiplayer.android = 500; })));
  r = pub('--file', raised);
  assert.equal(r.code, 1);
  assert.match(r.out, /android builds 0\.\.499 can no longer play online/);
  assert.match(r.out, /refused: re-run with --confirm-lock/);
  assert.equal(serial(), 2);
  r = pub('--file', raised, '--dry-run');
  assert.equal(r.code, 0, 'a dry run reports the lock and still exits 0');
  assert.match(r.out, /a real publish would refuse this without --confirm-lock/);
  r = pub('--file', raised, '--confirm-lock');
  assert.equal(r.code, 0, r.out);
  assert.equal(serial(), 3);
  assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).gates.min_build_multiplayer.android, 500);

  // A dry run against --live compares with that file instead.
  r = pub('--dry-run', '--live', raised);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /gates\.min_build_multiplayer\.android: 500 -> 0/);

  // Rollback brings the previous body back under a new serial.
  r = run('bash', ['ops/config/rollback.sh', 'dev', '--local-root', root, '--list']);
  assert.match(r.out, /3\tserial 3\n {2}2\tserial 2\n {2}1\tserial 1/);
  r = run('bash', ['ops/config/rollback.sh', 'dev', '--local-root', root, '--skip-client-check']);
  assert.equal(r.code, 0, r.out);
  assert.equal(serial(), 4);
  assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).gates.min_build_multiplayer.android, 0);
  assert.match(r.out, /gates\.min_build_multiplayer\.android: 500 -> 0/);

  // Rolling back to serial 3 raises the floor again, so it goes through the lock guard too.
  r = run('bash', ['ops/config/rollback.sh', 'dev', '3', '--local-root', root, '--skip-client-check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused/);
  assert.equal(serial(), 4);
});
