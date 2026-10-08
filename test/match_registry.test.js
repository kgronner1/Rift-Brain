'use strict';
// The M4 lobby registry over a fake box: spawning, seats and reservations, the lobby-wait queue, protocol routing,
// lobby lifetimes, and adoption after a brain restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../src/auth/tokens');
const {
  JOIN_KEY, FP_A, FP_B, ENV, manifestEntry, fakeHost, makeRegistry, player, beat,
} = require('./match_fixture');
const { HEARTBEAT_TIMEOUT_MS, EMPTY_LOBBY_MS, SEAT_RESERVATION_MS, BOOT_GRACE_MS } = require('../src/match/registry');

function joinToken(data, nowMs) {
  const r = verify(data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(nowMs / 1000) });
  assert.ok(r.ok, `join token does not verify: ${r.reason}`);
  return r.payload;
}

function onlyLobby(reg) {
  assert.equal(reg.lobbies.size, 1);
  return [...reg.lobbies.values()][0];
}

test('quickplay with no lobby spawns one, queues, and seats the player once it reports PREGAME', async () => {
  const { reg, host, clock } = makeRegistry();
  const p = player();
  const r = await reg.join(p);
  assert.equal(r.result, 'queued');
  assert.equal(r.queued.kind, 'lobby');
  assert.match(r.queued.ticket, /^q_[A-Za-z0-9_-]+$/);
  assert.equal(r.queued.position, 1);

  assert.equal(host.started.length, 1);
  const s = host.started[0];
  const lobby = onlyLobby(reg);
  assert.equal(s.binary, `/srv/wire-17-${FP_A}/server.x86_64`);
  assert.deepEqual(s.args, ['--port=8100', `--lobby_id=${lobby.id}`, '--net_env=dev', '--brain_url=http://127.0.0.1:3101']);
  assert.equal(s.env.RJ_JOIN_KEY, JOIN_KEY);
  assert.match(s.env.RJ_LOBBY_KEY, /^[0-9a-f]{64}$/);
  for (const secret of ['SESSION_KEY', 'LOBBY_MASTER_KEY', 'MYSQL_PASSWORD']) assert.equal(s.env[secret], undefined);
  assert.ok(!s.args.join(' ').includes(JOIN_KEY) && !s.args.join(' ').includes(s.env.RJ_LOBBY_KEY), 'keys never in argv');
  assert.equal(lobby.state, 'BOOTING');

  assert.equal(reg.poll(r.queued.ticket, p.install).result, 'queued');
  assert.equal((await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'))).result, 'ok');
  const ok = reg.poll(r.queued.ticket, p.install);
  assert.equal(ok.result, 'ok');
  assert.deepEqual(Object.keys(ok.data).sort(), ['host', 'join_token', 'port']);
  assert.equal(ok.data.host, 'play.example.test');
  assert.equal(ok.data.port, 8100);
  const tok = joinToken(ok.data, clock.t);
  assert.deepEqual(Object.keys(tok).sort(), ['env', 'exp', 'fp', 'host', 'iat', 'jti', 'lobby', 'seat', 'typ', 'uid', 'uname', 'v', 'wire'].sort());
  assert.equal(tok.uid, p.uid);
  assert.equal(tok.uname, p.uname);
  assert.equal(tok.lobby, lobby.id);
  assert.equal(tok.wire, 17);
  assert.equal(tok.fp, FP_A);
  assert.equal(tok.host, false);
  assert.equal(tok.exp - tok.iat, 60);
  assert.equal(lobby.seats.get(tok.seat).status, 'reserved');
  assert.equal(reg.poll(r.queued.ticket, p.install), null, 'a collected ticket is gone');
});

test('a second quickplay player is seated at once in the PREGAME lobby; capacity counts reservations and bots', async () => {
  const { reg, clock } = makeRegistry();
  await reg.join(player());
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME', { bots: 2 }));
  const a = await reg.join(player());
  assert.equal(a.result, 'ok');
  assert.equal(joinToken(a.data, clock.t).lobby, lobby.id);
  // 2 bots + the first player's admitted seat + this one = 4: the next player gets a new lobby.
  const b = await reg.join(player());
  assert.equal(b.result, 'queued');
  assert.equal(reg.lobbies.size, 2);
});

test('players on different protocols never share a lobby', async () => {
  const { reg } = makeRegistry({ entries: [manifestEntry(17, FP_A), manifestEntry(17, FP_B), manifestEntry(18, FP_A)] });
  await reg.join(player());
  const a = onlyLobby(reg);
  await reg.heartbeat(a.id, beat(a, 'PREGAME'));
  assert.equal((await reg.join(player())).result, 'ok', 'same (wire, fp) joins it');
  assert.equal((await reg.join(player({ fp: FP_B }))).result, 'queued', 'same wire, other fp: a lobby of its own');
  assert.equal((await reg.join(player({ wire: 18 }))).result, 'queued');
  const protocols = [...reg.lobbies.values()].map((l) => `${l.wire}/${l.fp}`).sort();
  assert.deepEqual(protocols, [`17/${FP_B}`, `17/${FP_A}`, `18/${FP_A}`].sort());
});

test('UPDATE_REQUIRED below min_wire or on a retired wire; SERVER_BEHIND for anything not deployed', async () => {
  const { reg, view, host } = makeRegistry({ entries: [manifestEntry(16, FP_A, 'retired'), manifestEntry(17, FP_A)] });
  view.gates.min_wire = 17;
  const r1 = await reg.join(player({ wire: 16 }));
  assert.deepEqual([r1.result, r1.code, r1.opts.scope], ['error', 'UPDATE_REQUIRED', 'multiplayer']);
  view.gates.min_wire = 1;
  assert.equal((await reg.join(player({ wire: 16 }))).code, 'UPDATE_REQUIRED', 'retired');
  assert.equal((await reg.join(player({ wire: 18 }))).code, 'SERVER_BEHIND', 'newer than everything');
  assert.equal((await reg.join(player({ fp: FP_B }))).code, 'SERVER_BEHIND', 'a sibling build');
  assert.equal((await reg.join(player({ mode: 'create_private', wire: 18 }))).code, 'SERVER_BEHIND');
  assert.equal(host.started.length, 0);
});

test('create_private boots a lobby, answers queued with a short poll, then hands the creator a host token and the code', async () => {
  const { reg, clock } = makeRegistry({ random: () => 0.5 });
  const p = player({ mode: 'create_private' });
  const r = await reg.join(p);
  assert.equal(r.result, 'queued');
  assert.equal(r.queued.poll_after_ms, 1000, 'booting: 1000 ms (± 20%)');
  const lobby = onlyLobby(reg);
  assert.match(lobby.privateCode, /^[A-Z]{4}$/);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const ok = reg.poll(r.queued.ticket, p.install);
  assert.equal(ok.result, 'ok');
  assert.equal(ok.data.private_code, lobby.privateCode);
  assert.equal(joinToken(ok.data, clock.t).host, true);
});

test('join_private: ok, LOBBY_NOT_FOUND, LOBBY_FULL, LOBBY_WRONG_VERSION, and queued while the match runs', async () => {
  const { reg, clock } = makeRegistry({ entries: [manifestEntry(17, FP_A), manifestEntry(17, FP_B)] });
  const creator = player({ mode: 'create_private' });
  const c = await reg.join(creator);
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  reg.poll(c.queued.ticket, creator.install);
  const code = lobby.privateCode;

  assert.equal((await reg.join(player({ mode: 'join_private', code: 'ZZZZ' === code ? 'YYYY' : 'ZZZZ' }))).code, 'LOBBY_NOT_FOUND');
  assert.equal((await reg.join(player({ mode: 'join_private', code: '12' }))).code, 'LOBBY_NOT_FOUND');
  assert.equal((await reg.join(player({ mode: 'join_private', code, fp: FP_B }))).code, 'LOBBY_WRONG_VERSION');
  const joined = await reg.join(player({ mode: 'join_private', code: code.toLowerCase() }));
  assert.equal(joined.result, 'ok');
  assert.equal(joined.data.private_code, code);
  assert.equal(joinToken(joined.data, clock.t).host, false);
  assert.equal((await reg.join(player({ mode: 'join_private', code }))).result, 'ok');
  assert.equal((await reg.join(player({ mode: 'join_private', code }))).result, 'ok');
  assert.equal((await reg.join(player({ mode: 'join_private', code }))).code, 'LOBBY_FULL');

  // The match starts; a fifth player waits for the lobby to come back to PREGAME with room.
  const seated = [...lobby.seats].map(([seat, s]) => ({ user_id: s.uid, seat }));
  await reg.heartbeat(lobby.id, beat(lobby, 'INGAME', { players: seated }));
  const late = player({ mode: 'join_private', code });
  const q = await reg.join(late);
  assert.equal(q.result, 'queued');
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME', { players: seated.slice(1) }));
  assert.equal(reg.poll(q.queued.ticket, late.install).result, 'ok');
});

test('NO_CAPACITY when every port is taken and the lobby-wait queue is at lobby_queue_max', async () => {
  const { reg, view, host } = makeRegistry();
  host.busy = new Set(ENV.GAME_PORTS);
  view.server.lobby_queue_max = 2;
  const a = await reg.join(player());
  const b = await reg.join(player());
  assert.deepEqual([a.result, b.result], ['queued', 'queued']);
  assert.equal(b.queued.position, 2);
  assert.equal(b.queued.poll_after_ms >= 2400 && b.queued.poll_after_ms <= 3600, true);
  assert.equal((await reg.join(player())).code, 'NO_CAPACITY');
  assert.equal((await reg.join(player({ mode: 'create_private' }))).code, 'NO_CAPACITY');
  assert.equal(host.started.length, 0, 'a port held by something else is never used');
  // A port frees up: the sweep spawns for the waiting players.
  host.busy.delete(8101);
  await reg.sweep();
  assert.equal(host.started.length, 1);
  assert.match(host.started[0].args[0], /--port=8101/);
});

test('a reservation lapses after 60 s; a ticket is install-bound; leaving releases the seat', async () => {
  const { reg, advance } = makeRegistry();
  await reg.join(player());
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const seatsBefore = lobby.seats.size;
  await reg.join(player());
  assert.equal(lobby.seats.size, seatsBefore + 1);
  advance(SEAT_RESERVATION_MS / 2);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  advance(SEAT_RESERVATION_MS / 2 + 1);
  await reg.sweep();
  assert.ok(reg.lobbies.has(lobby.id));
  assert.equal(lobby.seats.size, 0, 'unused reservations are freed');

  const { reg: r2, host } = makeRegistry();
  host.busy = new Set(ENV.GAME_PORTS);
  const p = player();
  const q = await r2.join(p);
  assert.equal(r2.poll(q.queued.ticket, 'another-install').code, 'QUEUE_TICKET_INVALID');
  assert.equal(r2.leave(q.queued.ticket, 'another-install').code, 'QUEUE_TICKET_INVALID');
  assert.equal(r2.leave(q.queued.ticket, p.install).result, 'ok');
  assert.equal(r2.poll(q.queued.ticket, p.install), null);
});

test('a lobby with no heartbeat for 45 s is stopped and its port reused', async () => {
  const { reg, host, advance } = makeRegistry();
  await reg.join(player());
  const lobby = onlyLobby(reg);
  advance(HEARTBEAT_TIMEOUT_MS - 1000);
  await reg.sweep();
  assert.equal(reg.lobbies.size, 1);
  advance(2000);
  await reg.sweep();
  assert.deepEqual(host.stopped.includes(lobby.id), true);
  // Its waiting player stayed in line and the sweep booted a replacement on the freed port.
  const next = onlyLobby(reg);
  assert.notEqual(next.id, lobby.id);
  assert.equal(next.port, 8100);
});

test('an empty lobby ends after POSTGAME, or after 120 s empty in PREGAME; player-left only frees the seat', async () => {
  const { reg, host, advance } = makeRegistry();
  const p = player();
  const q = await reg.join(p);
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const ok = reg.poll(q.queued.ticket, p.install);
  const seat = [...lobby.seats.keys()][0];
  assert.equal(reg.playerJoined(lobby.id, { user_id: p.uid, seat }).result, 'ok');
  assert.equal(ok.result, 'ok');
  assert.equal((await reg.playerLeft(lobby.id, { user_id: p.uid, seat })).result, 'ok');
  assert.equal(reg.lobbies.size, 1, 'player-left never kills the lobby');
  await reg.sweep();
  for (let ms = 0; ms < EMPTY_LOBBY_MS - 15000; ms += 15000) {
    advance(15000);
    await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME', { players: [] }));
    await reg.sweep();
  }
  assert.equal(reg.lobbies.get(lobby.id), lobby, 'still the same lobby, kept alive by its heartbeats');
  advance(15000);
  await reg.sweep();
  assert.equal(reg.lobbies.size, 0);
  assert.ok(host.stopped.includes(lobby.id));

  const { reg: r2 } = makeRegistry();
  await r2.join(player());
  const l2 = onlyLobby(r2);
  await r2.heartbeat(l2.id, beat(l2, 'POSTGAME', { players: [] }));
  for (const [seat] of l2.seats) l2.seats.delete(seat);
  r2.tickets.clear();
  await r2.sweep();
  assert.equal(r2.lobbies.size, 0, 'empty after POSTGAME: ended');
});

test('player-joined takes only the seat its token reserved; results trust only seated players', async () => {
  const { reg } = makeRegistry();
  const p = player();
  const q = await reg.join(p);
  const lobby = onlyLobby(reg);
  await reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  reg.poll(q.queued.ticket, p.install);
  const seat = [...lobby.seats.keys()][0];
  assert.equal(reg.playerJoined(lobby.id, { user_id: p.uid + 1, seat }).opts.status, 409);
  assert.equal(reg.playerJoined(lobby.id, { user_id: p.uid, seat: 'nope' }).code, 'VALIDATION');
  assert.equal(reg.playerJoined('unknownlobby1', { user_id: p.uid, seat }).code, 'LOBBY_NOT_FOUND');
  assert.equal(reg.verifiedSeat(lobby.id, p.uid), false, 'a reservation is not a seat');
  assert.equal(reg.playerJoined(lobby.id, { user_id: p.uid, seat }).result, 'ok');
  assert.equal(reg.verifiedSeat(lobby.id, p.uid), true);
  assert.equal(reg.verifiedSeat(lobby.id, p.uid + 1), false);
  // A heartbeat naming a seat that is not that player's is ignored.
  await reg.heartbeat(lobby.id, beat(lobby, 'INGAME', { players: [{ user_id: p.uid, seat }, { user_id: 999, seat: 'forged' }] }));
  assert.equal(reg.verifiedSeat(lobby.id, 999), false);
});

test('a restarted brain spawns nothing for 30 s, adopts lobbies that heartbeat, then stops its strays', async () => {
  const clock = { t: Date.UTC(2026, 9, 8, 13, 0, 0) };
  const host = fakeHost();
  // Before the restart: a brain that ran two lobbies.
  const before = makeRegistry({ clock, host });
  const creator = player({ mode: 'create_private' });
  const c = await before.reg.join(creator);
  const kept = onlyLobby(before.reg);
  await before.reg.heartbeat(kept.id, beat(kept, 'PREGAME'));
  before.reg.poll(c.queued.ticket, creator.install);
  const seat = [...kept.seats.keys()][0];
  before.reg.playerJoined(kept.id, { user_id: creator.uid, seat });
  await before.reg.join(player());
  const stray = [...before.reg.lobbies.values()].find((l) => l.id !== kept.id);
  const keptBeat = beat(kept, 'PREGAME');
  const code = kept.privateCode;

  // The restart: a new registry, same box.
  const after = makeRegistry({ clock, host, bootGraceMs: BOOT_GRACE_MS });
  after.reg.start();
  after.reg.stop();
  const startedBefore = host.started.length;
  const q = await after.reg.join(player());
  assert.equal(q.result, 'queued', 'joins wait out the adoption window');
  const early = player({ mode: 'join_private', code });
  const eq = await after.reg.join(early);
  assert.equal(eq.result, 'queued', 'an unknown code waits for the heartbeats too');
  await after.reg.sweep();
  assert.equal(host.started.length, startedBefore, 'nothing is spawned in the window');

  assert.equal((await after.reg.heartbeat(kept.id, keptBeat)).result, 'ok');
  const adopted = after.reg.lobbies.get(kept.id);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.privateCode, code);
  assert.equal(after.reg.verifiedSeat(kept.id, creator.uid), true, 'seats come back from the heartbeat');

  after.advance(BOOT_GRACE_MS);
  await after.reg.sweep();
  assert.deepEqual(host.stopped, [stray.id], 'only the lobby that never heartbeated is stopped');
  assert.ok(after.reg.lobbies.has(kept.id));
  assert.equal(after.reg.poll(eq.queued.ticket, early.install).result, 'ok', 'the code resolves to the adopted lobby');
  assert.ok(host.started.length > startedBefore, 'the quickplay player now gets a lobby');
});

test('an adopted heartbeat on a port another lobby holds is refused', async () => {
  const { reg } = makeRegistry();
  await reg.join(player());
  const lobby = onlyLobby(reg);
  const r = await reg.heartbeat('aaaaaaaaaaaaaaaaaaaaaaaa', beat(lobby, 'PREGAME'));
  assert.equal(r.code, 'VALIDATION');
  assert.equal(r.opts.status, 409);
  const bad = await reg.heartbeat(lobby.id, { ...beat(lobby, 'PREGAME'), state: 'DANCING' });
  assert.equal(bad.code, 'VALIDATION');
});

test('a binary that will not start answers INTERNAL instead of retrying every second', async () => {
  const { reg, host, logger } = makeRegistry();
  host.start = async () => { throw new Error('spawn ENOENT'); };
  assert.equal((await reg.join(player({ mode: 'create_private' }))).code, 'INTERNAL');
  assert.equal((await reg.join(player())).code, 'INTERNAL');
  assert.equal(reg.lobbies.size, 0, 'the port is not held by a lobby that never started');
  assert.match(logger.lines.join('\n'), /could not start .*spawn ENOENT/);
});
