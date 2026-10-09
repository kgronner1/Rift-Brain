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

test('drill 5 refuses before any network call', () => {
  let r = drill('drill5_stampede.sh', ['--env', 'alpha']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dev only/);
  r = drill('drill5_stampede.sh', ['--steady', '30']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--steady must be at least --window \+ 10/);
  r = drill('drill5_stampede.sh', ['--stop-cmd', 'true']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /go together/);
  r = drill('drill5_stampede.sh', ['--clients', '0']);
  assert.equal(r.status, 2);
  r = drill('drill5_stampede.sh', ['--clients', '3000']);
  assert.equal(r.status, 2);
  r = drill('drill5_stampede.sh', ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PLAN/);
});

// swarm_report.py on made-up swarm logs (RJ 471). n clients, each sending a request every `beat` ms from its own
// phase; the brain is down over [down, back), when every request fails in transport; after `back`, each lost client's
// next request is at reconnectAt(index), ok.
const REPORT = path.join(ROOT, 'ops/drills/swarm_report.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

function swarmLog({ n = 50, beat = 10000, down = 100000, back = 130000, end = 220000, reconnectAt, startUnix = 1700000000000,
  first = 1, health = 20, skip = new Set() } = {}) {
  const lines = [`# net_swarm start_unix_ms=${startUnix} n=${n} first=${first} prefix=swarm ramp_sec=10 beat_sec=10 run_sec=220 env=dev api=x`,
    't_ms,client,op,result,ms'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c = first + i;
    const phase = Math.floor((i * beat) / n);
    rows.push([phase % 1000, c, 'config', 'ok']);
    rows.push([Math.floor((i * 10000) / n), c, 'login', 'ok']);
    let t = 10000 + phase;
    while (t < down) { rows.push([t, c, 'restore', 'ok']); t += beat; }
    while (t < back) { rows.push([t, c, 'restore', 'NET_UNREACHABLE']); t += beat; }
    if (skip.has(c)) continue;
    t = reconnectAt(i);
    rows.push([t, c, 'restore', 'ok']);
    t += beat;
    while (t < end) { rows.push([t, c, 'restore', 'ok']); t += beat; }
  }
  rows.sort((a, b) => a[0] - b[0]);
  lines.push('# all_signed_in t_ms=10000');
  for (const r of rows) lines.push(`${r[0]},${r[1]},${r[2]},${r[3]},3`);
  for (let t = 10000; t <= end; t += 10000) {
    lines.push(`# health t_ms=${t} clients=${n} signed_in=${n} retrying=0 max_frame_gap_ms=${health}`);
  }
  return `${lines.join('\n')}\n`;
}

function report(logs, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-swarm-'));
  const files = logs.map((text, i) => {
    const f = path.join(dir, `requests.${i}.csv`);
    fs.writeFileSync(f, text);
    return f;
  });
  const json = path.join(dir, 'report.json');
  const r = spawnSync('python3', ['-I', REPORT, ...files, '--json', json, ...args], { encoding: 'utf8' });
  const out = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

test('swarm_report.py: reconnects spread over 30 s pass; the same reconnects in one second fail', { skip: !hasPython }, () => {
  let r = report([swarmLog({ reconnectAt: (i) => 130000 + Math.floor((i * 30000) / 50) })]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /STAMPEDE VERDICT: PASS/);
  assert.equal(r.out.steady_mean, 5);
  assert.equal(r.out.lost, 50);
  assert.equal(r.out.reconnected, 50);
  assert.equal(r.out.outage_sec, 30);
  assert.ok(r.out.peak <= 10, `peak ${r.out.peak}`);

  r = report([swarmLog({ reconnectAt: (i) => 130000 + (i % 3) * 100 })]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STAMPEDE FAIL {2}peak reconnect bucket 50 vs the limit 10\.0/);
  assert.match(r.stdout, /STAMPEDE VERDICT: FAIL/);
  assert.match(r.stdout, /<- brain back/);
});

test('swarm_report.py: a measurement that did not work is a FAIL that says why', { skip: !hasPython }, () => {
  const spread = (i) => 130000 + Math.floor((i * 30000) / 50);
  let r = report([swarmLog({ down: 300000, back: 300000, reconnectAt: () => 999999 })]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no outage in the log/);
  r = report([swarmLog({ reconnectAt: spread, skip: new Set([7, 9]) })]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2 of 50 clients that lost the brain never got back/);
  r = report([swarmLog({ reconnectAt: spread, health: 1500 })]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the swarm process stalled/);
  r = report([swarmLog({ down: 50000, back: 80000, reconnectAt: (i) => 80000 + Math.floor((i * 30000) / 50) })]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no full 60 s steady window before the outage/);
});

test('swarm_report.py merges one log per process on their start times', { skip: !hasPython }, () => {
  const a = swarmLog({ n: 25, reconnectAt: (i) => 130000 + Math.floor((i * 30000) / 25) });
  // The second process started 2 s later: its clock reads 2 s less for the same instant.
  const b = swarmLog({ n: 25, first: 26, startUnix: 1700000002000, down: 98000, back: 128000, end: 218000,
    reconnectAt: (i) => 128000 + Math.floor((i * 30000) / 25) });
  const r = report([a, b]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.clients, 50);
  assert.equal(r.out.lost, 50);
  assert.equal(r.out.outage_sec, 30);
});
