'use strict';
// The release drills' pure parts (RJ 470, spec M8): drill.mjs, and the scripts' refusals before any network call.
// The drills themselves run against local brains in ops/drills/test/drills_local.sh (Docker).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MJS = path.join(ROOT, 'ops/drills/drill.mjs');

function mjs(args, input) {
  return spawnSync('node', [MJS, ...args], { input: input ?? '', encoding: 'utf8' });
}

function drill(script, args) {
  return spawnSync('bash', [path.join(ROOT, 'ops/drills', script), ...args], {
    encoding: 'utf8', env: { ...process.env, RJ_WOBBLE_PLANET: '/nonexistent' }, timeout: 10000,
  });
}

test('drill.mjs envelope: one line per reply, "-" for what is absent', () => {
  const err = JSON.stringify({ result: 'error', error: { code: 'SERVER_BEHIND', scope: 'multiplayer',
    retry: { kind: 'after', after_ms: 300000 }, action: { kind: 'dismiss' } } });
  assert.equal(mjs(['envelope', '503'], err).stdout.trim(), '503 error SERVER_BEHIND multiplayer after 300000 dismiss');
  assert.equal(mjs(['envelope', '200'], '{"result":"ok","data":{}}').stdout.trim(), '200 ok - - - - -');
  assert.equal(mjs(['envelope', '000'], '').stdout.trim(), '000 unparsed - - - - -');
  assert.equal(mjs(['envelope', '502'], '<html>').stdout.trim(), '502 unparsed - - - - -');
});

test('drill.mjs session and credential read a /v1/session reply', () => {
  const login = JSON.stringify({ result: 'ok', data: { user: { id: 7, username: 'user7' },
    session: { token: 'abc.def', expires_in: 3600 }, credential: { user_id: 7, token: 'cred' } } });
  assert.equal(mjs(['session'], login).stdout.trim(), '7 abc.def');
  assert.deepEqual(JSON.parse(mjs(['credential'], login).stdout), { user_id: 7, token: 'cred' });
  const restore = JSON.stringify({ result: 'ok', data: { user: { id: 7 }, session: { token: 't' } } });
  assert.equal(mjs(['credential'], restore).status, 1);
  assert.equal(mjs(['session'], '{"result":"error","error":{"code":"AUTH_INVALID"}}').status, 1);
});

test('drill.mjs get and set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-drill-'));
  const f = path.join(dir, 'doc.json');
  fs.writeFileSync(f, JSON.stringify({ env: 'dev', gates: { min_build_multiplayer: { default: 0 }, min_wire: 1 } }));
  assert.equal(mjs(['get', f, 'env']).stdout.trim(), 'dev');
  assert.equal(mjs(['get', f, 'gates.min_wire']).stdout.trim(), '1');
  assert.equal(mjs(['get', f, 'gates.nothing']).stdout.trim(), '');
  const out = JSON.parse(mjs(['set', f, 'gates.min_build_multiplayer.android', '5001']).stdout);
  assert.deepEqual(out.gates.min_build_multiplayer, { default: 0, android: 5001 });
  assert.equal(out.gates.min_wire, 1);
  fs.rmSync(dir, { recursive: true });
});

test('the drills refuse before any network call', () => {
  let r = drill('drill1_version_floor.sh', ['--wire', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--build <N> is required/);
  r = drill('drill1_version_floor.sh', ['--build', '5', '--wire', '2', '--env', 'alpha']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dev only/);
  r = drill('drill1_version_floor.sh', ['--build', '5']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--wire <W> is required/);
  r = drill('drill2_server_behind.sh', ['--env', 'prod', '--wire', '2']);
  assert.equal(r.status, 2);
  r = drill('drill7_env_isolation.sh', ['--dev-api', 'http://x', '--alpha-api', 'http://x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /same brain/);
  for (const s of ['drill1_version_floor.sh', 'drill2_server_behind.sh', 'drill7_env_isolation.sh']) {
    r = drill(s, ['--help']);
    assert.equal(r.status, 0, s);
    assert.match(r.stdout, /PLAN/, s);
  }
});
