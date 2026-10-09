'use strict';
// A game server that crashes at boot (2026-10-09: wire 2 SIGSEGV'd before its first line, the brain respawned it every
// 45 s and every crash dumped core): the registry ends a lobby whose process exits, counts the lobbies of one
// (wire, fp) that die before their first heartbeat, and stops spawning that protocol after CRASH_LOOP_LIMIT of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FP_A, FP_B, manifestEntry, makeRegistry, player, beat } = require('./match_fixture');
const { CRASH_LOOP_LIMIT, CRASH_COOLDOWN_MS, HEARTBEAT_TIMEOUT_MS } = require('../src/match/registry');

function onlyLobby(reg) {
  assert.equal(reg.lobbies.size, 1);
  return [...reg.lobbies.values()][0];
}

const creator = (extra = {}) => player({ mode: 'create_private', ...extra });

// A private lobby is created (one spawn, whose creator is told INTERNAL if it dies: nobody waits on to respawn it), then
// its server crashes before heartbeating. Resolves the crashed lobby's id.
async function crashOnce(reg, host) {
  const before = host.started.length;
  const r = await reg.join(creator());
  assert.equal(r.result, 'queued', `join answered ${r.code || r.result}`);
  assert.equal(host.started.length, before + 1, 'a server was spawned');
  const id = host.started[host.started.length - 1].lobbyId;
  await host.exit(id);
  return id;
}

test('a lobby whose server exits ends at once, and its port is free again', async () => {
  const { reg, host, logger } = makeRegistry();
  await reg.join(player());
  const lobby = onlyLobby(reg);
  await host.exit(lobby.id, null, 'SIGSEGV');
  assert.equal(reg.lobbies.has(lobby.id), false);
  assert.ok(logger.lines.some((l) => l.includes(`lobby ${lobby.id}`) && l.includes('killed by SIGSEGV')), logger.lines.join('\n'));
  assert.ok(logger.lines.some((l) => l.includes('died before its first heartbeat') && l.includes('1 in a row')));
});

test(`${CRASH_LOOP_LIMIT} early deaths in a row stop that protocol: SERVER_BEHIND, nothing spawned, CRASH LOOP logged`, async () => {
  const { reg, host, logger } = makeRegistry({ entries: [manifestEntry(17, FP_A), manifestEntry(17, FP_B)] });
  for (let i = 0; i < CRASH_LOOP_LIMIT; i++) await crashOnce(reg, host);
  assert.equal(host.started.length, CRASH_LOOP_LIMIT);
  assert.ok(logger.lines.some((l) => l.includes('CRASH LOOP') && l.includes(`wire 17 fp ${FP_A}`)), logger.lines.join('\n'));

  const spawned = host.started.length;
  for (const mode of ['quickplay', 'create_private']) {
    const r = await reg.join(player({ mode }));
    assert.deepEqual([r.result, r.code], ['error', 'SERVER_BEHIND'], mode);
  }
  await reg.sweep();
  assert.equal(host.started.length, spawned, 'nothing spawned while the breaker is open');

  const other = await reg.join(player({ fp: FP_B }));
  assert.equal(other.result, 'queued', 'another protocol is untouched');
  assert.equal(host.started.length, spawned + 1);
});

test('a waiting quickplay player is answered SERVER_BEHIND when the breaker trips under them', async () => {
  const { reg, host } = makeRegistry();
  const p = player();
  const r = await reg.join(p);
  for (let i = 0; i < CRASH_LOOP_LIMIT; i++) {
    await host.exit(host.started[host.started.length - 1].lobbyId);
    await reg.sweep(); // the ticket still waits: the sweep's drain respawns for it, until the breaker trips
  }
  assert.equal(host.started.length, CRASH_LOOP_LIMIT);
  const polled = reg.poll(r.queued.ticket, p.install);
  assert.deepEqual([polled.result, polled.code], ['error', 'SERVER_BEHIND']);
});

test('the cool-down ends; one more early death trips it again; a heartbeat resets the count', async () => {
  const { reg, host, advance, logger } = makeRegistry();
  for (let i = 0; i < CRASH_LOOP_LIMIT; i++) await crashOnce(reg, host);
  assert.equal((await reg.join(creator())).code, 'SERVER_BEHIND');

  advance(CRASH_COOLDOWN_MS);
  await crashOnce(reg, host);
  assert.ok(logger.lines.some((l) => l.includes('may spawn again after its cool-down')));
  assert.equal((await reg.join(creator())).code, 'SERVER_BEHIND', 'still failing: blocked again after one more');

  advance(CRASH_COOLDOWN_MS);
  await reg.join(creator());
  const lobby = onlyLobby(reg);
  assert.equal((await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'))).result, 'ok');
  assert.equal(reg.crashes.size, 0, 'a server that heartbeats clears the count');
  await crashOnce(reg, host);
  assert.equal((await reg.join(creator())).result, 'queued', 'one early death after a good boot is not a loop');
});

test('early deaths count in a row only: a lobby that heartbeats in between resets the count', async () => {
  const { reg, host } = makeRegistry();
  for (let i = 0; i < CRASH_LOOP_LIMIT - 1; i++) await crashOnce(reg, host);
  await reg.join(creator());
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  await host.exit(lobby.id, 0, null); // a server that ran, then exited: ends its lobby, counts nothing
  assert.equal(reg.lobbies.size, 0);
  for (let i = 0; i < CRASH_LOOP_LIMIT - 1; i++) await crashOnce(reg, host);
  assert.equal((await reg.join(creator())).result, 'queued');
});

test('a server that never heartbeats and is never seen to exit counts too, at the 45 s timeout', async () => {
  const { reg, host, advance } = makeRegistry();
  for (let i = 0; i < CRASH_LOOP_LIMIT; i++) {
    await reg.join(creator());
    advance(HEARTBEAT_TIMEOUT_MS + 1000);
    await reg.sweep();
  }
  assert.equal(reg.crashes.values().next().value.early, CRASH_LOOP_LIMIT);
  assert.equal((await reg.join(creator())).code, 'SERVER_BEHIND');
  assert.ok(host.stopped.length >= CRASH_LOOP_LIMIT);
});

test('an adopted lobby that goes quiet is not an early death', async () => {
  const { reg, advance } = makeRegistry();
  const id = 'adoptedlobby0001';
  await reg.heartbeat(id, { port: 8100, wire: 17, fp: FP_A, state: 'PREGAME', players: [], bots: 0, private_code: '' });
  advance(HEARTBEAT_TIMEOUT_MS + 1000);
  await reg.sweep();
  assert.equal(reg.lobbies.has(id), false);
  assert.equal(reg.crashes.size, 0);
});

test('an exit after the lobby already ended (the brain stopped it) changes nothing', async () => {
  const { reg, host } = makeRegistry();
  await reg.join(player());
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  reg.lobbies.delete(lobby.id);
  await host.exit(lobby.id, null, 'SIGTERM');
  assert.equal(reg.crashes.size, 0);
});

test('the sweep has the host maintain its logs once a minute', async () => {
  const { reg, host, advance } = makeRegistry();
  await reg.sweep();
  await reg.sweep();
  assert.equal(host.maintained, 1);
  advance(60 * 1000);
  await reg.sweep();
  assert.equal(host.maintained, 2);
});
