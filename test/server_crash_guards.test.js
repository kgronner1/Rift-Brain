'use strict';
// The box side of a crashing game server (2026-10-09), for real: a spawned server runs with RLIMIT_CORE 0 (soft and
// hard), the brain hears it die and how, its output lands in its lobby's log, and the logs are capped and pruned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHost, childEnv, noCoreCommand, maintainLogs } = require('../src/match/host');

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeServer(dir, body) {
  const bin = path.join(dir, 'servers', 'wire-2-3934cd86524daa0f', 'server.x86_64');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('noCoreCommand: /bin/sh sets the core limit to 0 and execs the binary with its argv unchanged', () => {
  const [cmd, argv] = noCoreCommand('/opt/rj/dev/servers/wire-2-x/server.x86_64', ['--port=8100', '--lobby_id=a b']);
  assert.equal(cmd, '/bin/sh');
  assert.deepEqual(argv, ['-c', 'ulimit -c 0 && exec "$0" "$@"', '/opt/rj/dev/servers/wire-2-x/server.x86_64', '--port=8100', '--lobby_id=a b']);
});

test('a spawned server runs with no core dump (soft and hard limit 0), as itself, its output in its lobby log', async (t) => {
  const dir = tmpdir(t);
  const bin = fakeServer(dir, 'echo "soft=$(ulimit -c) hard=$(ulimit -Hc) args=$*"\nsleep 5');
  const logDir = path.join(dir, 'logs', 'servers');
  const host = createHost({ serversDir: path.join(dir, 'servers'), logDir });
  assert.ok(fs.statSync(logDir).isDirectory(), 'createHost makes SERVER_LOGS_DIR');
  const lobbyId = 'feedfacecafe0001';
  const pid = await host.start({ binary: bin, args: ['--port=1', `--lobby_id=${lobbyId}`], env: childEnv({}), lobbyId });
  const logFile = path.join(logDir, `lobby-${lobbyId}.log`);
  assert.equal(host.logFile(lobbyId), logFile);
  assert.ok(await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('soft=')), 'no output');
  assert.match(fs.readFileSync(logFile, 'utf8'), new RegExp(`soft=0 hard=0 args=--port=1 --lobby_id=${lobbyId}`));
  const mine = await host.ownServers();
  assert.deepEqual(mine.map((s) => [s.pid, s.lobbyId]), [[pid, lobbyId]], 'one process, the pid spawn returned (the wrapper exec\'d)');
  assert.equal(await host.stop(lobbyId), 1);
});

test('the brain hears a server die, and by which signal', async (t) => {
  const dir = tmpdir(t);
  const bin = fakeServer(dir, 'echo booting\nkill -SEGV $$');
  const logDir = path.join(dir, 'logs');
  const host = createHost({ serversDir: path.join(dir, 'servers'), logDir });
  let heard = null;
  await host.start({ binary: bin, args: ['--lobby_id=deadbeef0001'], env: childEnv({}), lobbyId: 'deadbeef0001',
    onExit: (code, sig) => { heard = { code, sig }; } });
  assert.ok(await waitFor(() => heard !== null), 'onExit never fired');
  assert.deepEqual(heard, { code: null, sig: 'SIGSEGV' });
  assert.match(fs.readFileSync(path.join(logDir, 'lobby-deadbeef0001.log'), 'utf8'), /booting/);
});

test('a missing binary is refused, not started as a wrapper with nothing to exec', async (t) => {
  const dir = tmpdir(t);
  const host = createHost({ serversDir: dir, logDir: null });
  await assert.rejects(host.start({ binary: path.join(dir, 'missing'), args: [], env: {}, lobbyId: 'x' }));
});

test('maintainLogs: a log past the cap is copied to .1 and truncated; old and surplus lobbies are deleted', (t) => {
  const dir = tmpdir(t);
  const now = Date.now();
  const write = (name, bytes, ageMs) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x'.repeat(bytes));
    const s = (now - ageMs) / 1000;
    fs.utimesSync(f, s, s);
    return f;
  };
  const big = write('lobby-big00000001.log', 300, 0);
  write('lobby-new00000001.log', 10, 1000);
  write('lobby-new00000002.log', 10, 2000);
  write('lobby-new00000003.log', 10, 3000);
  write('lobby-old00000001.log', 10, 10 * 24 * 3600 * 1000);
  write('lobby-old00000001.log.1', 10, 10 * 24 * 3600 * 1000);
  write('unrelated.txt', 10, 10 * 24 * 3600 * 1000);

  // Truncating in place keeps an O_APPEND writer's next line at the start of the file.
  const fd = fs.openSync(big, 'a');
  const r = maintainLogs(dir, { maxBytes: 100, maxFiles: 3, maxAgeMs: 7 * 24 * 3600 * 1000, now });
  fs.writeSync(fd, 'after');
  fs.closeSync(fd);

  assert.equal(r.rotated, 1);
  assert.equal(fs.readFileSync(`${big}.1`, 'utf8').length, 300);
  assert.equal(fs.readFileSync(big, 'utf8'), 'after');
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['lobby-big00000001.log', 'lobby-big00000001.log.1', 'lobby-new00000001.log',
    'lobby-new00000002.log', 'unrelated.txt'], 'the 4th newest and the 10-day-old lobby are gone; other files untouched');
  assert.equal(r.deleted, 3);
  assert.deepEqual(maintainLogs(path.join(dir, 'nope')), { rotated: 0, deleted: 0 }, 'a missing dir is not an error');
});
