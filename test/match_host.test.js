'use strict';
// The box side of a lobby (match/host.js) for real: the UDP bind test, a spawned server's argv and environment, and
// stopping only our own servers.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { udpPortFree, childEnv, serverArgs, ownServers, createHost } = require('../src/match/host');

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('the UDP bind test sees a port in use, and a free one', async () => {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '0.0.0.0', r));
  const port = sock.address().port;
  assert.equal(await udpPortFree(port), false);
  await new Promise((r) => sock.close(r));
  assert.equal(await udpPortFree(port), true);
});

test('a game server gets its keys in its environment, not argv, and none of the brain\'s secrets', () => {
  const env = childEnv({ RJ_JOIN_KEY: 'j', RJ_LOBBY_KEY: 'l' }, {
    PATH: '/usr/bin', HOME: '/home/x', SESSION_KEY: 's', MYSQL_PASSWORD: 'p', LOBBY_MASTER_KEY: 'm', JOIN_KEY: 'jk',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/x', RJ_JOIN_KEY: 'j', RJ_LOBBY_KEY: 'l' });
  assert.deepEqual(serverArgs({ port: 8100, lobbyId: 'abc123abc123', netEnv: 'dev', brainUrl: 'http://127.0.0.1:3101', privateCode: 'ABCD' }),
    ['--port=8100', '--lobby_id=abc123abc123', '--net_env=dev', '--brain_url=http://127.0.0.1:3101', '--private_code=ABCD']);
});

test('ownServers: only processes under SERVERS_DIR that carry --lobby_id', () => {
  const ps = [
    { pid: 1, args: '/opt/rj/dev/servers/wire-17-aa/server.x86_64 --port=8100 --lobby_id=abcdef012345' },
    { pid: 2, args: '/opt/rj/dev/servers2/wire-17-aa/server.x86_64 --lobby_id=zzzzzzzzzzzz' },
    { pid: 3, args: '/opt/rj/alpha/servers/wire-17-aa/server.x86_64 --lobby_id=yyyyyyyyyyyy' },
    { pid: 4, args: 'vim /opt/rj/dev/servers/manifest.json' },
    { pid: 5, args: '/home/ec2-user/rift_jumper_multiplayer_server_test.x86_64 --port=8080' },
    { pid: 6, args: '/Applications/Godot.app/Contents/MacOS/Godot --headless --server --lobby_id=bbbbbbbbbbbb --brain_url=http://127.0.0.1:3101' },
    { pid: 7, args: 'Godot --lobby_id=cccccccccccc --brain_url=http://127.0.0.1:3102' },
  ];
  assert.deepEqual(ownServers(ps, '/opt/rj/dev/servers').map((s) => [s.pid, s.lobbyId]), [[1, 'abcdef012345']]);
  assert.deepEqual(ownServers(ps, '/opt/rj/dev/servers', 'http://127.0.0.1:3101').map((s) => s.pid), [1, 6],
    'a wrapper that execs keeps its --brain_url');
});

test('a real spawn: detached, argv and env as given; stop() reaches it by lobby id and nothing else', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-servers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'wire-17-9f2c4e1a0b7d3c55', 'server.x86_64');
  fs.mkdirSync(path.dirname(bin));
  const out = path.join(dir, 'out.txt');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${out}.tmp"\necho "J=$RJ_JOIN_KEY L=$RJ_LOBBY_KEY S=$SESSION_KEY" >> "${out}.tmp"\nmv "${out}.tmp" "${out}"\nsleep 5\n`);
  fs.chmodSync(bin, 0o755);
  const host = createHost({ serversDir: dir, logDir: dir });
  const lobbyId = 'feedfacecafe0123';
  const prev = process.env.SESSION_KEY;
  process.env.SESSION_KEY = 'brain-secret';
  let pid;
  try {
    pid = await host.start({ binary: bin, args: [`--port=1`, `--lobby_id=${lobbyId}`], env: childEnv({ RJ_JOIN_KEY: 'jk', RJ_LOBBY_KEY: 'lk' }), lobbyId });
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEY; else process.env.SESSION_KEY = prev;
  }
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.ok(await waitFor(() => fs.existsSync(out)), 'the server never ran');
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, new RegExp(`--port=1 --lobby_id=${lobbyId}`));
  assert.match(text, /J=jk L=lk S=\n/);
  assert.ok(await waitFor(async () => (await host.ownServers()).some((s) => s.lobbyId === lobbyId)), 'ownServers does not see it');
  assert.equal(await host.stop('000000000000'), 0, 'another lobby id stops nothing');
  assert.equal(await host.stop(lobbyId), 1);
  assert.ok(await waitFor(async () => !(await host.ownServers()).some((s) => s.lobbyId === lobbyId)), 'it is still running');
  await assert.rejects(host.start({ binary: path.join(dir, 'missing'), args: [], env: {}, lobbyId: 'x' }));
});
