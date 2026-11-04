'use strict';
// RJ 539, spectating, in the lobby registry over a fake box: a lobby whose latest heartbeat says
// admits_spectators: true is seatable mid-match (INGAME, POSTGAME) for a code join, an invite, a follower, the lobby
// wait and quickplay; one without it (an older server) is waited on exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../src/auth/tokens');
const { JOIN_KEY, FP_A, ENV, makeRegistry, player, beat } = require('./match_fixture');
const { BOOT_GRACE_MS, SEAT_RESERVATION_MS } = require('../src/match/registry');

const RUNNING = ['INGAME', 'POSTGAME'];
const MANY_PORTS = Object.freeze({ ...ENV, GAME_PORTS: Object.freeze([8100, 8101, 8102, 8103, 8104, 8105, 8106, 8107, 8108]) });

function tokenOf(data, nowMs) {
  const r = verify(data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(nowMs / 1000) });
  assert.ok(r.ok, `join token does not verify: ${r.reason}`);
  return r.payload;
}

// A join_user request from a new player, for <inviter> (a player()).
function follower(inviter, extra = {}) {
  return player({ mode: 'join_user', inviter: { uid: inviter.uid, uname: inviter.uname }, ...extra });
}

// Every seat <lobby> holds, as the heartbeat's players (each reservation's player connected).
function everyone(lobby) {
  return [...lobby.seats].map(([seat, s]) => ({ user_id: s.uid, seat }));
}

function report(m, lobby, state, opts = {}) {
  return m.reg.heartbeat(lobby.id, beat(lobby, state, { players: everyone(lobby), ...opts }));
}

// A new private lobby with its creator connected, then reporting <state> with <opts> (bots, admits). Resolves
// {lobby, creator}.
async function privateLobby(m, state, opts = {}) {
  const creator = player({ mode: 'create_private' });
  const c = await m.reg.join(creator);
  assert.equal(c.result, 'queued');
  const lobby = [...m.reg.lobbies.values()].pop();
  await m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const r = m.reg.poll(c.queued.ticket, creator.install);
  assert.equal(r.result, 'ok');
  assert.equal(m.reg.playerJoined(lobby.id, { user_id: creator.uid, seat: tokenOf(r.data, m.clock.t).seat }).result, 'ok');
  assert.equal((await report(m, lobby, state, opts)).result, 'ok');
  return { lobby, creator };
}

// A lobby this brain did not spawn heartbeats in on <port> (adoption): <humans> players seated, <bots>, and
// admits_spectators when <admits> is not undefined. Resolves the lobby.
let nextUid = 90000;
async function adopt(m, id, port, state, { humans = 1, bots = 0, admits, code = '' } = {}) {
  const players = [];
  for (let i = 0; i < humans; i++) players.push({ user_id: nextUid++, seat: `${id}-seat-${i}` });
  const b = { port, wire: 17, fp: FP_A, state, players, bots, private_code: code, pid: 40000 + port };
  if (admits !== undefined) b.admits_spectators = admits;
  assert.equal((await m.reg.heartbeat(id, b)).result, 'ok');
  return m.reg.lobbies.get(id);
}

test('the gate: without admits_spectators: true a running lobby seats nobody mid-match; a code and an invite wait for PREGAME as before', async () => {
  for (const admits of [undefined, false]) {
    const m = makeRegistry();
    const { lobby, creator } = await privateLobby(m, 'INGAME', { admits });
    const x = player({ mode: 'join_private', code: lobby.privateCode });
    const rx = await m.reg.join(x);
    assert.deepEqual([rx.result, rx.queued.kind, rx.queued.message],
      ['queued', 'lobby', 'That match is still running. You will join when it ends.'], `admits ${admits}`);
    const y = follower(creator);
    const ry = await m.reg.join(y);
    assert.deepEqual([ry.result, ry.queued.kind], ['queued', 'lobby']);
    for (const state of [...RUNNING, 'INGAME']) {
      await report(m, lobby, state, { admits });
      await m.reg.sweep();
      assert.equal(m.reg.poll(rx.queued.ticket, x.install).result, 'queued', state);
      assert.equal(m.reg.poll(ry.queued.ticket, y.install).result, 'queued', state);
      assert.equal((await m.reg.join(player({ mode: 'join_private', code: lobby.privateCode }))).result, 'queued');
    }
    assert.equal(lobby.seats.size, 1, 'only the creator holds a seat');
    assert.equal(m.host.started.length, 1);
    await report(m, lobby, 'PREGAME', { admits });
    assert.equal(tokenOf(m.reg.poll(rx.queued.ticket, x.install).data, m.clock.t).lobby, lobby.id);
    assert.equal(tokenOf(m.reg.poll(ry.queued.ticket, y.install).data, m.clock.t).lobby, lobby.id);
  }
});

test('the gate is the latest heartbeat: a lobby whose server stops saying admits_spectators seats nobody mid-match', async () => {
  const m = makeRegistry();
  const { lobby, creator } = await privateLobby(m, 'INGAME', { admits: true });
  assert.equal((await m.reg.join(player({ mode: 'join_private', code: lobby.privateCode }))).result, 'ok');
  await report(m, lobby, 'INGAME');
  assert.equal((await m.reg.join(player({ mode: 'join_private', code: lobby.privateCode }))).result, 'queued');
  assert.equal((await m.reg.join(follower(creator))).result, 'queued');
  await report(m, lobby, 'INGAME', { admits: true });
  assert.equal(lobby.seats.size, 4, 'the heartbeat that admits spectators again seated the two waiting');
  assert.equal((await m.reg.join(player({ mode: 'join_private', code: lobby.privateCode }))).result, 'queued', 'full');
  assert.ok(m.logger.lines.some((l) => l.includes(`lobby ${lobby.id} no longer admits spectators`)));
  assert.ok(m.logger.lines.some((l) => l.includes(`lobby ${lobby.id} admits spectators`)));
});

test('the gate: quickplay passes by a public running lobby without admits_spectators and spawns, as before', async () => {
  const m = makeRegistry();
  const old = await adopt(m, 'gate-public-ingame', 8100, 'INGAME', { humans: 1 });
  const post = await adopt(m, 'gate-public-postgame', 8101, 'POSTGAME', { humans: 2, admits: false });
  const p = player();
  const r = await m.reg.join(p);
  assert.equal(r.result, 'queued');
  assert.equal(m.host.started.length, 1, 'a lobby spawned for it');
  assert.deepEqual([old.seats.size, post.seats.size], [1, 2]);
  const fresh = [...m.reg.lobbies.values()].find((l) => l.state === 'BOOTING');
  await m.reg.heartbeat(fresh.id, beat(fresh, 'PREGAME'));
  assert.equal(tokenOf(m.reg.poll(r.queued.ticket, p.install).data, m.clock.t).lobby, fresh.id);
});

test('a code join is seated at once in a running lobby that admits spectators, INGAME or POSTGAME', async () => {
  for (const state of RUNNING) {
    const m = makeRegistry();
    const { lobby } = await privateLobby(m, state, { admits: true });
    const x = player({ mode: 'join_private', code: lobby.privateCode.toLowerCase() });
    const r = await m.reg.join(x);
    assert.equal(r.result, 'ok', state);
    assert.deepEqual(Object.keys(r.data).sort(), ['host', 'join_token', 'port', 'private_code']);
    assert.equal(r.data.private_code, lobby.privateCode);
    const tok = tokenOf(r.data, m.clock.t);
    assert.deepEqual([tok.lobby, tok.uid, tok.host], [lobby.id, x.uid, false]);
    assert.equal(lobby.seats.get(tok.seat).status, 'reserved');
    assert.equal(m.host.started.length, 1, 'nothing spawned');
  }
});

test('an invite is seated at once in the inviter\'s running lobby that admits spectators, INGAME or POSTGAME', async () => {
  for (const state of RUNNING) {
    const m = makeRegistry();
    const { lobby, creator } = await privateLobby(m, state, { admits: true });
    const y = follower(creator);
    const r = await m.reg.join(y);
    assert.equal(r.result, 'ok', state);
    assert.equal(r.data.private_code, lobby.privateCode);
    const tok = tokenOf(r.data, m.clock.t);
    assert.deepEqual([tok.lobby, tok.uid, tok.host], [lobby.id, y.uid, false]);
  }
});

test('a follower is seated the moment the inviter takes a seat in a running lobby that admits spectators', async () => {
  for (const state of RUNNING) {
    const m = makeRegistry();
    const { lobby } = await privateLobby(m, state, { admits: true });
    const a = player({ mode: 'join_private', code: lobby.privateCode });
    const b = follower(a);
    const c = follower(b);
    const qb = await m.reg.join(b);
    const qc = await m.reg.join(c);
    assert.deepEqual([qb.queued.kind, qc.queued.kind], ['follow', 'follow']);
    const ra = await m.reg.join(a);
    assert.equal(ra.result, 'ok', state);
    assert.equal(tokenOf(ra.data, m.clock.t).lobby, lobby.id);
    for (const [q, who] of [[qb, b], [qc, c]]) {
      const p = m.reg.poll(q.queued.ticket, who.install);
      assert.equal(p.result, 'ok', `${state} ${who.uname}`);
      assert.equal(tokenOf(p.data, m.clock.t).lobby, lobby.id);
    }
    assert.equal(lobby.seats.size, 4);
  }
});

test('a full running lobby that admits spectators is waited on: a seat that opens mid-match is taken; a full PREGAME is still LOBBY_FULL', async () => {
  const m = makeRegistry();
  const { lobby, creator } = await privateLobby(m, 'INGAME', { admits: true, bots: 3 });
  const code = lobby.privateCode;
  const x = player({ mode: 'join_private', code });
  const rx = await m.reg.join(x);
  assert.deepEqual([rx.result, rx.queued.message], ['queued', 'That match is still running. You will join when it ends.']);
  const y = follower(creator);
  const ry = await m.reg.join(y);
  assert.deepEqual([ry.result, ry.queued.kind], ['queued', 'lobby']);
  await m.reg.sweep();
  assert.equal(m.reg.poll(rx.queued.ticket, x.install).result, 'queued', 'not LOBBY_FULL mid-match');

  // A bot leaves mid-match: the first in line takes the seat, as a spectator.
  await report(m, lobby, 'INGAME', { admits: true, bots: 2 });
  const px = m.reg.poll(rx.queued.ticket, x.install);
  assert.equal(px.result, 'ok');
  assert.equal(tokenOf(px.data, m.clock.t).lobby, lobby.id);
  assert.equal(m.reg.poll(ry.queued.ticket, y.install).result, 'queued');

  // Full again: a later code join waits, and learns LOBBY_FULL only when the lobby reaches PREGAME still full.
  const w = player({ mode: 'join_private', code });
  const rw = await m.reg.join(w);
  assert.equal(rw.result, 'queued');
  await report(m, lobby, 'POSTGAME', { admits: true, bots: 2 });
  assert.equal(m.reg.poll(rw.queued.ticket, w.install).result, 'queued');
  await report(m, lobby, 'PREGAME', { admits: true, bots: 2 });
  assert.equal(m.reg.poll(rw.queued.ticket, w.install).code, 'LOBBY_FULL');
  const py = m.reg.poll(ry.queued.ticket, y.install);
  assert.deepEqual([py.result, py.queued.message], ['queued', 'That lobby is full. You will join when a seat opens.'], 'an invite waits on');
  assert.equal((await m.reg.join(player({ mode: 'join_private', code }))).code, 'LOBBY_FULL', 'a full PREGAME, at once');
});

test('player-left in a running lobby that admits spectators seats the next in line at once; without it, nobody', async () => {
  for (const admits of [true, undefined]) {
    const m = makeRegistry();
    const { lobby } = await privateLobby(m, 'PREGAME', { bots: 2 });
    const x = player({ mode: 'join_private', code: lobby.privateCode });
    const tx = tokenOf((await m.reg.join(x)).data, m.clock.t);
    m.reg.playerJoined(lobby.id, { user_id: x.uid, seat: tx.seat });
    await report(m, lobby, 'INGAME', { admits, bots: 2 });
    const y = player({ mode: 'join_private', code: lobby.privateCode });
    const ry = await m.reg.join(y);
    assert.equal(ry.result, 'queued', 'full');
    assert.equal((await m.reg.playerLeft(lobby.id, { user_id: x.uid, seat: tx.seat })).result, 'ok');
    const p = m.reg.poll(ry.queued.ticket, y.install);
    assert.equal(p.result, admits ? 'ok' : 'queued', `admits ${admits}`);
  }
});

test('a spectator holds its seat as a player does: reserved by its token, seated by player-joined, kept by the heartbeat\'s players', async () => {
  const m = makeRegistry();
  const { lobby, creator } = await privateLobby(m, 'INGAME', { admits: true });
  const code = lobby.privateCode;
  const x = player({ mode: 'join_private', code });
  const tok = tokenOf((await m.reg.join(x)).data, m.clock.t);
  assert.equal(m.reg.playerJoined(lobby.id, { user_id: x.uid, seat: tok.seat }).result, 'ok');
  assert.equal(lobby.seats.get(tok.seat).status, 'seated');
  assert.equal(m.reg.verifiedSeat(lobby.id, x.uid), true, 'its match results count');
  // Listed in players through the match: kept well past a reservation's 60 s.
  for (let i = 0; i < 8; i++) {
    m.advance(15 * 1000);
    await report(m, lobby, 'INGAME', { admits: true });
    await m.reg.sweep();
  }
  assert.ok(m.clock.t - tok.iat * 1000 > SEAT_RESERVATION_MS);
  assert.equal(lobby.seats.get(tok.seat).status, 'seated');
  // It counts toward capacity: the creator, the spectator and 2 bots are a full lobby.
  await report(m, lobby, 'INGAME', { admits: true, bots: 2 });
  const y = player({ mode: 'join_private', code });
  const ry = await m.reg.join(y);
  assert.equal(ry.result, 'queued');
  assert.equal(m.reg.leave(ry.queued.ticket, y.install).result, 'ok');
  // The next PREGAME changes nothing for the brain; a heartbeat that no longer lists it frees the seat.
  await report(m, lobby, 'PREGAME', { admits: true, bots: 2 });
  assert.equal(lobby.seats.get(tok.seat).status, 'seated');
  const creatorSeat = everyone(lobby).filter((s) => s.user_id === creator.uid);
  await m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME', { players: creatorSeat, bots: 2, admits: true }));
  assert.equal(lobby.seats.has(tok.seat), false);

  // A spectator who never connects loses its reservation after 60 s, as a player does.
  await report(m, lobby, 'INGAME', { admits: true });
  const z = player({ mode: 'join_private', code });
  const tz = tokenOf((await m.reg.join(z)).data, m.clock.t);
  assert.equal(lobby.seats.get(tz.seat).status, 'reserved');
  m.advance(SEAT_RESERVATION_MS + 1);
  await report(m, lobby, 'INGAME', { admits: true, players: creatorSeat });
  await m.reg.sweep();
  assert.equal(lobby.seats.has(tz.seat), false);
});

test('quickplay: PREGAME, then POSTGAME, then INGAME, the fullest first in each; only lobbies that admit spectators, public, with a human in', async () => {
  const m = makeRegistry({ env: MANY_PORTS });
  const pre = await adopt(m, 'order-pregame-0001', 8100, 'PREGAME', { humans: 1, bots: 2 });
  const priv = await adopt(m, 'order-private-0001', 8101, 'POSTGAME', { humans: 2, bots: 1, admits: true, code: 'QQQQ' });
  const post = await adopt(m, 'order-postgame-001', 8102, 'POSTGAME', { humans: 1, bots: 1, admits: true });
  const post2 = await adopt(m, 'order-postgame-002', 8103, 'POSTGAME', { humans: 1, admits: true });
  const old = await adopt(m, 'order-old-ingame01', 8104, 'INGAME', { humans: 2, bots: 1 });
  const botsOnly = await adopt(m, 'order-bots-only-01', 8105, 'INGAME', { humans: 0, bots: 3, admits: true });
  const in2 = await adopt(m, 'order-ingame-00002', 8106, 'INGAME', { humans: 2, admits: true });
  const in1 = await adopt(m, 'order-ingame-00001', 8107, 'INGAME', { humans: 1, admits: true });
  const expected = [pre, post, post, post2, post2, post2, in2, in2, in1, in1, in1];
  for (const [i, l] of expected.entries()) {
    const r = await m.reg.join(player());
    assert.equal(r.result, 'ok', `player ${i + 1}: ${JSON.stringify(r)}`);
    assert.equal(tokenOf(r.data, m.clock.t).lobby, l.id, `player ${i + 1}`);
  }
  assert.equal(m.host.started.length, 0, 'nothing spawned while a lobby had room');
  assert.deepEqual([priv.seats.size, old.seats.size, botsOnly.seats.size], [2, 2, 0], 'passed by');
  const last = player();
  const r = await m.reg.join(last);
  assert.equal(r.result, 'queued');
  assert.equal(m.host.started.length, 1, 'nothing seatable has room: a spawn');
});

test('quickplay with followers: a running lobby with room for all of them, over a sooner one without; else a spawn for them', async () => {
  const m = makeRegistry({ env: MANY_PORTS });
  const post = await adopt(m, 'room-postgame-0001', 8100, 'POSTGAME', { humans: 2, bots: 1, admits: true });
  const ingame = await adopt(m, 'room-ingame-000001', 8101, 'INGAME', { humans: 1, admits: true });
  const a = player();
  const fs = [follower(a), follower(a)];
  const qs = [];
  for (const f of fs) qs.push(await m.reg.join(f));
  const ra = await m.reg.join(a);
  assert.equal(ra.result, 'ok');
  assert.equal(tokenOf(ra.data, m.clock.t).lobby, ingame.id, 'POSTGAME has one seat; a and two followers need three');
  for (let i = 0; i < fs.length; i++) {
    const p = m.reg.poll(qs[i].queued.ticket, fs[i].install);
    assert.equal(p.result, 'ok', `follower ${i}`);
    assert.equal(tokenOf(p.data, m.clock.t).lobby, ingame.id);
  }
  assert.equal(ingame.seats.size, 4);

  // b and a follower need two seats; only POSTGAME's one is left: a spawn, counting the follower but not the solo
  // player placed after them.
  const b = player();
  const qf = await m.reg.join(follower(b));
  assert.equal(qf.queued.kind, 'follow');
  const rb = await m.reg.join(b);
  assert.equal(rb.result, 'queued');
  assert.equal(m.host.started.length, 1);
  const solo = player();
  const rs = await m.reg.join(solo);
  assert.equal(rs.result, 'queued', 'behind b in line, then placed by the drain');
  assert.equal(tokenOf(m.reg.poll(rs.queued.ticket, solo.install).data, m.clock.t).lobby, post.id);
  await m.reg.sweep();
  assert.equal(m.host.started.length, 1, 'one lobby for b and the follower, none for the solo player');
});

test('the queue\'s quickplay tickets take the same order, and the spawn counts only the players none of them has room for', async () => {
  const m = makeRegistry({ env: MANY_PORTS, bootGraceMs: BOOT_GRACE_MS });
  m.reg.start();
  m.reg.stop();
  const ps = [player(), player(), player(), player(), player()];
  const qs = [];
  for (const p of ps) qs.push(await m.reg.join(p));
  assert.deepEqual(qs.map((q) => q.result), ['queued', 'queued', 'queued', 'queued', 'queued'], 'the adoption window');
  const ingame = await adopt(m, 'drain-ingame-00001', 8100, 'INGAME', { humans: 1, admits: true });
  const post = await adopt(m, 'drain-postgame-001', 8101, 'POSTGAME', { humans: 1, bots: 2, admits: true });
  const old = await adopt(m, 'drain-old-ingame01', 8102, 'INGAME', { humans: 1 });
  await m.reg.sweep();
  assert.equal(m.reg.poll(qs[0].queued.ticket, ps[0].install).result, 'queued', 'nobody is seated in the window');
  m.advance(BOOT_GRACE_MS + 1);
  await m.reg.sweep();
  const lobbyOf = (i) => {
    const r = m.reg.poll(qs[i].queued.ticket, ps[i].install);
    return r.result === 'ok' ? tokenOf(r.data, m.clock.t).lobby : r.result;
  };
  assert.deepEqual([0, 1, 2, 3].map(lobbyOf), [post.id, ingame.id, ingame.id, ingame.id]);
  assert.equal(old.seats.size, 1);
  assert.equal(m.host.started.length, 1, 'one spawn, for the fifth player');
  const fresh = [...m.reg.lobbies.values()].find((l) => l.state === 'BOOTING');
  await m.reg.heartbeat(fresh.id, beat(fresh, 'PREGAME'));
  assert.equal(lobbyOf(4), fresh.id);
});

test('an adopted lobby that admits spectators is seatable once the adoption window closes, not during it', async () => {
  for (const admits of [true, undefined]) {
    const m = makeRegistry({ bootGraceMs: BOOT_GRACE_MS });
    m.reg.start();
    m.reg.stop();
    const a = player();
    const b = follower(a);
    const qb = await m.reg.join(b);
    assert.equal(qb.queued.kind, 'follow', 'the inviter\'s lobby is not known yet');
    const hb = { port: 8101, wire: 17, fp: FP_A, state: 'INGAME', players: [{ user_id: a.uid, seat: 'seat-a' }], bots: 0, pid: 4242, private_code: 'KQZX' };
    if (admits !== undefined) hb.admits_spectators = admits;
    assert.equal((await m.reg.heartbeat('adopted-spectate-1', hb)).result, 'ok');
    const lobby = m.reg.lobbies.get('adopted-spectate-1');
    assert.equal(lobby.admitsSpectators, admits === true);
    const x = player({ mode: 'join_private', code: 'KQZX' });
    const qx = await m.reg.join(x);
    const c = follower(a);
    const qc = await m.reg.join(c);
    assert.deepEqual([qx.result, qc.result, qc.queued.kind], ['queued', 'queued', 'lobby'], `admits ${admits}: in the window`);
    await m.reg.heartbeat(lobby.id, hb);
    await m.reg.sweep();
    const tickets = [[qx, x], [qc, c], [qb, b]];
    for (const [q, who] of tickets) assert.equal(m.reg.poll(q.queued.ticket, who.install).result, 'queued');
    assert.equal(lobby.seats.size, 1);

    m.advance(BOOT_GRACE_MS + 1);
    await m.reg.sweep();
    if (admits) {
      for (const [q, who] of tickets) {
        const p = m.reg.poll(q.queued.ticket, who.install);
        assert.equal(p.result, 'ok', who.uname);
        assert.deepEqual([tokenOf(p.data, m.clock.t).lobby, p.data.private_code], [lobby.id, 'KQZX']);
      }
      assert.equal(lobby.seats.size, 4);
    } else {
      for (const [q, who] of tickets) {
        const p = m.reg.poll(q.queued.ticket, who.install);
        assert.deepEqual([p.result, p.queued.kind], ['queued', 'lobby'], who.uname);
      }
      await m.reg.heartbeat(lobby.id, { ...hb, state: 'PREGAME' });
      for (const [q, who] of tickets) assert.equal(m.reg.poll(q.queued.ticket, who.install).result, 'ok', who.uname);
    }
  }
});

test('a heartbeat whose admits_spectators is not a boolean is VALIDATION and changes nothing; absent is false', async () => {
  const m = makeRegistry();
  const { lobby } = await privateLobby(m, 'PREGAME');
  for (const bad of ['true', 1, 0, null, {}, []]) {
    const r = await m.reg.heartbeat(lobby.id, { ...beat(lobby, 'INGAME'), admits_spectators: bad });
    assert.deepEqual([r.result, r.code], ['error', 'VALIDATION'], JSON.stringify(bad));
    assert.match(r.opts.message, /admits_spectators must be a boolean/);
    assert.deepEqual([lobby.state, lobby.admitsSpectators], ['PREGAME', false]);
  }
  const unknown = { port: 8102, wire: 17, fp: FP_A, state: 'INGAME', players: [], bots: 0, admits_spectators: 'yes' };
  assert.equal((await m.reg.heartbeat('unknown-lobby-0001', unknown)).code, 'VALIDATION');
  assert.equal(m.reg.lobbies.has('unknown-lobby-0001'), false, 'not adopted');
  for (const [admits, want] of [[true, true], [false, false], [undefined, false], [true, true]]) {
    assert.equal((await report(m, lobby, 'INGAME', { admits })).result, 'ok');
    assert.equal(lobby.admitsSpectators, want, `admits ${admits}`);
  }
});
