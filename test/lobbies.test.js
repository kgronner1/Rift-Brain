'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLobbyRegistry, QUEUE_TICKET_POLL_TTL, QUEUE_RESERVATION_TTL } = require('../src/match/lobbies');
const { firstFreePort } = require('../src/match/ports');

function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

// A registry whose "processes" are recorded, never run.
function fakeRegistry(t, opts = {}) {
  quiet(t);
  const commands = [];
  let clock = 1_000_000;
  let nextPid = 100;
  const lobbies = createLobbyRegistry({
    ports: [8080, 8081],
    serverBinary: '/bin/game',
    runCommand: async (command, args = []) => {
      commands.push([command, ...args]);
      return command.startsWith('kill ') ? '' : nextPid++;
    },
    now: () => clock,
    readyTimeoutMs: 50,
    ...opts,
  });
  t.after(() => lobbies.stop());
  return { lobbies, commands, advance: (ms) => { clock += ms; } };
}

test('firstFreePort takes the configured order', () => {
  assert.equal(firstFreePort([8081, 8080], {}), 8081);
  assert.equal(firstFreePort([8080, 8081], { 8080: {} }), 8081);
  assert.equal(firstFreePort([8080], { 8080: {} }), null);
});

test('a new instance launches the configured binary and waits for ready', async (t) => {
  const { lobbies, commands } = fakeRegistry(t);
  const pending = lobbies.createGameInstance('ABCD');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(commands, [['/bin/game', '--port=8080', '--private_code=ABCD']]);
  lobbies.game_instances[8080].healthy = true;
  assert.equal(await pending, 8080);
  assert.equal(lobbies.game_instances[8080].private_code, 'ABCD');
  assert.equal(lobbies.game_instances[8080].pid, 100);
});

test('an instance that never reports ready answers the wait code', async (t) => {
  const { lobbies } = fakeRegistry(t);
  assert.equal(await lobbies.createGameInstance(), 1);
});

test('no free port answers the wait code without launching', async (t) => {
  const { lobbies, commands } = fakeRegistry(t, { ports: [] });
  assert.equal(await lobbies.createGameInstance(), 1);
  assert.deepEqual(commands, []);
});

test('the queue admits in order, reservations hold seats, and ending a lobby invalidates its tickets', async (t) => {
  const { lobbies, commands } = fakeRegistry(t);
  const pending = lobbies.createGameInstance('WXYZ');
  await new Promise((r) => setImmediate(r));
  const g = lobbies.game_instances[8080];
  g.healthy = true;
  await pending;
  g.lobby_state = 'INGAME';

  const queued = [];
  for (let i = 0; i < 5; i++) {
    const r = lobbies.checkForJoinablePrivateGame('WXYZ');
    assert.equal(r.game_port, 4);
    queued.push(r.ticket_id);
  }
  assert.equal(lobbies.checkForJoinablePrivateGame('NOPE').game_port, 1);

  g.lobby_state = 'PREGAME';
  g.players = 1;
  lobbies.drainJoinQueue();
  const admitted = lobbies.join_queue.filter((x) => x.admitted_port === 8080).map((x) => x.ticket_id);
  assert.deepEqual(admitted, queued.slice(0, 3));
  assert.equal(lobbies.reservedCount(8080), 3);
  assert.equal(lobbies.checkForJoinablePrivateGame('WXYZ').game_port, 3);

  await lobbies.endGameInstance(8080);
  assert.deepEqual(commands.at(-1), ['kill 100']);
  assert.equal(lobbies.game_instances[8080], undefined);
  assert.equal(lobbies.join_queue.length, 0);
});

test('the sweep purges unpolled tickets and stale reservations', (t) => {
  const { lobbies, advance } = fakeRegistry(t);
  const a = lobbies.createJoinTicket(null);
  advance(QUEUE_TICKET_POLL_TTL - 1);
  const b = lobbies.createJoinTicket(null);
  lobbies.sweepJoinQueue();
  assert.equal(lobbies.join_queue.length, 2);
  advance(2);
  lobbies.sweepJoinQueue();
  assert.deepEqual(lobbies.join_queue.map((x) => x.ticket_id), [b.ticket_id]);

  b.admitted_port = 8081;
  b.admitted_at = 0;
  b.last_poll_at = Infinity;
  advance(QUEUE_RESERVATION_TTL + 1);
  lobbies.sweepJoinQueue();
  assert.equal(lobbies.join_queue.length, 0);
  assert.notEqual(a.ticket_id, b.ticket_id);
});
