'use strict';
// RJ 458, invite links, in the lobby registry over a fake box (Wobble Planet specs/invite-links.md, 2.3): every outcome
// of join_user, the follow ticket (seated, mid-match, full, timeout, live followers), and quickplay with followers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('../src/auth/tokens');
const {
  JOIN_KEY, FP_A, FP_B, ENV, manifestEntry, makeRegistry, player, beat,
} = require('./match_fixture');
const { FOLLOW_WINDOW_MS, TICKET_TTL_MS, ADMITTED_HOLD_MS, BOOT_GRACE_MS } = require('../src/match/registry');

function tokenOf(data, nowMs) {
  const r = verify(data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(nowMs / 1000) });
  assert.ok(r.ok, `join token does not verify: ${r.reason}`);
  return r.payload;
}

// A join_user request from a new player, for <inviter> (a player()).
function follower(inviter, extra = {}) {
  return player({ mode: 'join_user', inviter: { uid: inviter.uid, uname: inviter.uname }, ...extra });
}

function lobbyOf(reg, id) {
  const l = reg.lobbies.get(id);
  assert.ok(l, `lobby ${id}`);
  return l;
}

function bootingLobbies(reg) {
  return [...reg.lobbies.values()].filter((l) => l.state === 'BOOTING');
}

// <p> (a player()) quickplays and takes the seat it is handed, spawning a lobby when none has room. Resolves
// {lobby, token}: the lobby in PREGAME, p seated in it.
async function seatByQuickplay(m, p) {
  let r = await m.reg.join(p);
  if (r.result === 'queued') {
    for (const l of bootingLobbies(m.reg)) await m.reg.heartbeat(l.id, beat(l, 'PREGAME'));
    r = m.reg.poll(r.queued.ticket, p.install);
  }
  assert.equal(r.result, 'ok', JSON.stringify(r));
  const token = tokenOf(r.data, m.clock.t);
  const lobby = lobbyOf(m.reg, token.lobby);
  assert.equal(m.reg.playerJoined(lobby.id, { user_id: p.uid, seat: token.seat }).result, 'ok');
  return { lobby, token, data: r.data };
}

// The heartbeat of <lobby> in <state> with every seat it holds reported seated.
async function report(m, lobby, state, extra = {}) {
  const players = [...lobby.seats].map(([seat, s]) => ({ user_id: s.uid, seat }));
  return m.reg.heartbeat(lobby.id, beat(lobby, state, { players, ...extra }));
}

test('outcome 5: the inviter holds no seat -> queued, kind follow, naming them, the 600 s window', async () => {
  const m = makeRegistry({ random: () => 0.5 });
  const a = player();
  const b = follower(a);
  const r = await m.reg.join(b);
  assert.equal(r.result, 'queued');
  assert.deepEqual(Object.keys(r.queued).sort(), ['eta_sec', 'expires_in_sec', 'kind', 'message', 'poll_after_ms', 'position', 'ticket']);
  assert.equal(r.queued.kind, 'follow');
  assert.equal(r.queued.expires_in_sec, 600);
  assert.equal(r.queued.position, 1);
  assert.equal(r.queued.poll_after_ms, 3000);
  assert.equal(r.queued.message, `Waiting for ${a.uname} to start a match...`);
  assert.equal(m.host.started.length, 0, 'a follow spawns nothing');
  m.advance(30 * 1000);
  const p = m.reg.poll(r.queued.ticket, b.install);
  assert.deepEqual([p.result, p.queued.kind, p.queued.expires_in_sec], ['queued', 'follow', 570], 'the window counts down; a poll does not extend it');
  const c = follower(a);
  assert.equal((await m.reg.join(c)).queued.position, 2, 'the second follower of the same inviter');
  assert.equal(FOLLOW_WINDOW_MS, 600 * 1000);
});

test('outcome 4: the inviter in a PREGAME lobby with room -> ok, a seat in that lobby (private_code for a private one)', async () => {
  const m = makeRegistry();
  const a = player();
  const { lobby } = await seatByQuickplay(m, a);
  const b = follower(a);
  const r = await m.reg.join(b);
  assert.equal(r.result, 'ok');
  assert.deepEqual(Object.keys(r.data).sort(), ['host', 'join_token', 'port']);
  const tok = tokenOf(r.data, m.clock.t);
  assert.deepEqual([tok.lobby, tok.uid, tok.host], [lobby.id, b.uid, false]);
  assert.equal(lobby.seats.get(tok.seat).status, 'reserved');

  // A private lobby: its code comes with the seat, as join_private's does.
  const host = player({ mode: 'create_private' });
  const c = await m.reg.join(host);
  const priv = [...m.reg.lobbies.values()].find((l) => l.privateCode);
  await m.reg.heartbeat(priv.id, beat(priv, 'PREGAME'));
  assert.equal(m.reg.poll(c.queued.ticket, host.install).result, 'ok');
  const d = await m.reg.join(follower(host));
  assert.equal(d.result, 'ok');
  assert.equal(d.data.private_code, priv.privateCode);
  assert.equal(tokenOf(d.data, m.clock.t).lobby, priv.id);
});

test('outcome 4: a reserved seat counts as the inviter\'s, before they connect', async () => {
  const m = makeRegistry();
  const first = player();
  const { lobby } = await seatByQuickplay(m, first);
  const a = player();
  assert.equal((await m.reg.join(a)).result, 'ok', 'a has a reservation in the lobby, not yet seated');
  const r = await m.reg.join(follower(a));
  assert.equal(r.result, 'ok');
  assert.equal(tokenOf(r.data, m.clock.t).lobby, lobby.id);
});

test('outcome 3: the inviter in a lobby on another (wire, fp) -> LOBBY_WRONG_VERSION, at once and for a follower', async () => {
  const m = makeRegistry({ entries: [manifestEntry(17, FP_A), manifestEntry(17, FP_B)] });
  const a = player({ fp: FP_B });
  await seatByQuickplay(m, a);
  const r = await m.reg.join(follower(a));
  assert.deepEqual([r.result, r.code], ['error', 'LOBBY_WRONG_VERSION']);

  // A follower whose inviter then takes a seat on the other protocol learns the same at its next poll.
  const c = player({ fp: FP_B });
  const d = follower(c);
  const q = await m.reg.join(d);
  assert.equal(q.queued.kind, 'follow');
  await seatByQuickplay(m, c);
  const p = m.reg.poll(q.queued.ticket, d.install);
  assert.deepEqual([p.result, p.code], ['error', 'LOBBY_WRONG_VERSION']);
});

test('outcome 4: INGAME, POSTGAME or full -> queued, kind lobby; seated at the next PREGAME or the next free seat', async () => {
  const m = makeRegistry();
  const a = player();
  const { lobby } = await seatByQuickplay(m, a);
  await report(m, lobby, 'INGAME');
  const b = follower(a);
  const r = await m.reg.join(b);
  assert.deepEqual([r.result, r.queued.kind, r.queued.message], ['queued', 'lobby', 'That match is still running. You will join when it ends.']);
  await report(m, lobby, 'POSTGAME');
  assert.equal(m.reg.poll(r.queued.ticket, b.install).result, 'queued');
  const c = follower(a);
  const rc = await m.reg.join(c);
  assert.deepEqual([rc.result, rc.queued.kind], ['queued', 'lobby'], 'POSTGAME is mid-match too');
  await report(m, lobby, 'PREGAME');
  const pb = m.reg.poll(r.queued.ticket, b.install);
  assert.equal(pb.result, 'ok');
  assert.equal(tokenOf(pb.data, m.clock.t).lobby, lobby.id);
  assert.equal(m.reg.poll(rc.queued.ticket, c.install).result, 'ok');

  // Full in PREGAME: an invite waits for a seat, where a code join is told LOBBY_FULL.
  const m2 = makeRegistry();
  const x = player({ mode: 'create_private' });
  const cx = await m2.reg.join(x);
  const full = bootingLobbies(m2.reg)[0];
  await m2.reg.heartbeat(full.id, beat(full, 'PREGAME', { bots: 3 }));
  assert.equal(m2.reg.poll(cx.queued.ticket, x.install).result, 'ok');
  assert.equal((await m2.reg.join(player({ mode: 'join_private', code: full.privateCode }))).code, 'LOBBY_FULL');
  const y = follower(x);
  const ry = await m2.reg.join(y);
  assert.deepEqual([ry.result, ry.queued.kind, ry.queued.message], ['queued', 'lobby', 'That lobby is full. You will join when a seat opens.']);
  await m2.reg.sweep();
  assert.equal(m2.reg.poll(ry.queued.ticket, y.install).result, 'queued', 'still waiting, not LOBBY_FULL');
  await report(m2, full, 'PREGAME', { bots: 2 });
  const py = m2.reg.poll(ry.queued.ticket, y.install);
  assert.equal(py.result, 'ok');
  assert.equal(tokenOf(py.data, m2.clock.t).lobby, full.id);
});

test('follow -> seated: the inviter quickplays into a lobby, and the follower\'s next poll answers ok in it', async () => {
  const m = makeRegistry();
  const someone = player();
  const { lobby } = await seatByQuickplay(m, someone);
  const a = player();
  const b = follower(a);
  const q = await m.reg.join(b);
  assert.equal(q.queued.kind, 'follow');
  const ra = await m.reg.join(a);
  assert.equal(ra.result, 'ok');
  assert.equal(tokenOf(ra.data, m.clock.t).lobby, lobby.id);
  const pb = m.reg.poll(q.queued.ticket, b.install);
  assert.equal(pb.result, 'ok');
  const tb = tokenOf(pb.data, m.clock.t);
  assert.deepEqual([tb.lobby, tb.uid, tb.host], [lobby.id, b.uid, false]);
  assert.equal(m.reg.poll(q.queued.ticket, b.install), null, 'a collected ticket is gone');
});

test('follow -> seated: the inviter hosts (create_private); the new lobby takes the followers when it is ready', async () => {
  const m = makeRegistry();
  const a = player({ mode: 'create_private' });
  const b = follower(a);
  const c = follower(a);
  const qb = await m.reg.join(b);
  const qc = await m.reg.join(c);
  const ra = await m.reg.join(a);
  assert.equal(ra.result, 'queued');
  assert.equal(m.reg.poll(qb.queued.ticket, b.install).queued.kind, 'follow', 'the lobby boots; still following');
  const lobby = bootingLobbies(m.reg)[0];
  await m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const pa = m.reg.poll(ra.queued.ticket, a.install);
  assert.equal(pa.result, 'ok');
  assert.equal(tokenOf(pa.data, m.clock.t).host, true);
  for (const [q, who] of [[qb, b], [qc, c]]) {
    const p = m.reg.poll(q.queued.ticket, who.install);
    assert.equal(p.result, 'ok', who.uname);
    assert.equal(p.data.private_code, lobby.privateCode);
    assert.equal(tokenOf(p.data, m.clock.t).lobby, lobby.id);
  }
});

test('follow -> seated: a code join (join_private) by the inviter brings the followers too', async () => {
  const m = makeRegistry();
  const host = player({ mode: 'create_private' });
  const c = await m.reg.join(host);
  const lobby = bootingLobbies(m.reg)[0];
  await m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  m.reg.poll(c.queued.ticket, host.install);
  const a = player({ mode: 'join_private', code: lobby.privateCode });
  const b = follower(a);
  const q = await m.reg.join(b);
  assert.equal((await m.reg.join(a)).result, 'ok');
  const p = m.reg.poll(q.queued.ticket, b.install);
  assert.equal(p.result, 'ok');
  assert.equal(tokenOf(p.data, m.clock.t).lobby, lobby.id);
});

test('follow -> mid-match -> lobby wait: an inviter found playing (after a brain restart) turns the follow into the lobby wait', async () => {
  const m = makeRegistry({ bootGraceMs: BOOT_GRACE_MS });
  m.reg.start();
  m.reg.stop();
  const a = player();
  const b = follower(a);
  const q = await m.reg.join(b);
  assert.equal(q.queued.kind, 'follow', 'in the adoption window the inviter\'s lobby is not known yet');
  // The lobby a's match runs in heartbeats in, and is adopted with a seated.
  await m.reg.heartbeat('adoptedlobby0001', { port: 8101, wire: 17, fp: FP_A, state: 'INGAME', players: [{ user_id: a.uid, seat: 'seat-a' }], bots: 0, pid: 4242 });
  const adopted = lobbyOf(m.reg, 'adoptedlobby0001');
  m.advance(BOOT_GRACE_MS + 1);
  await m.reg.sweep();
  const p = m.reg.poll(q.queued.ticket, b.install);
  assert.deepEqual([p.result, p.queued.kind, p.queued.message], ['queued', 'lobby', 'That match is still running. You will join when it ends.']);
  m.advance(FOLLOW_WINDOW_MS);
  await m.reg.heartbeat(adopted.id, beat(adopted, 'POSTGAME', { players: [{ user_id: a.uid, seat: 'seat-a' }] }));
  assert.equal(m.reg.poll(q.queued.ticket, b.install).result, 'queued', 'a lobby wait has no follow window');
  await m.reg.heartbeat(adopted.id, beat(adopted, 'PREGAME', { players: [{ user_id: a.uid, seat: 'seat-a' }] }));
  const ok = m.reg.poll(q.queued.ticket, b.install);
  assert.equal(ok.result, 'ok');
  assert.equal(tokenOf(ok.data, m.clock.t).lobby, adopted.id);
});

test('follow -> full: as many followers as fit are seated, FIFO; the rest wait for a seat in that lobby', async () => {
  const m = makeRegistry();
  const x = player({ mode: 'create_private' });
  const c = await m.reg.join(x);
  const lobby = bootingLobbies(m.reg)[0];
  await m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME', { bots: 1 }));
  assert.equal(m.reg.poll(c.queued.ticket, x.install).result, 'ok');
  const a = player({ mode: 'join_private', code: lobby.privateCode });
  const fs = [follower(a), follower(a), follower(a)];
  const qs = [];
  for (const f of fs) qs.push(await m.reg.join(f));
  // x + 1 bot + a leaves one seat: the first follower gets it. (A code join is not placed by its followers.)
  assert.equal((await m.reg.join(a)).result, 'ok');
  assert.equal(m.reg.poll(qs[0].queued.ticket, fs[0].install).result, 'ok');
  const p1 = m.reg.poll(qs[1].queued.ticket, fs[1].install);
  assert.deepEqual([p1.result, p1.queued.kind, p1.queued.message], ['queued', 'lobby', 'That lobby is full. You will join when a seat opens.']);
  assert.equal(m.reg.poll(qs[2].queued.ticket, fs[2].install).queued.kind, 'lobby');
  // The bot leaves: the next follower in line gets the seat, the last one keeps waiting.
  await report(m, lobby, 'PREGAME', { bots: 0 });
  assert.equal(m.reg.poll(qs[1].queued.ticket, fs[1].install).result, 'ok');
  assert.equal(m.reg.poll(qs[2].queued.ticket, fs[2].install).result, 'queued');
});

test('follow timeout: no seat in the window -> FOLLOW_TIMEOUT at the poll, or at the sweep; the window is configurable', async () => {
  const m = makeRegistry();
  const a = player();
  const b = follower(a);
  const q = await m.reg.join(b);
  for (let t = 0; t < FOLLOW_WINDOW_MS - 30000; t += 30000) {
    m.advance(30000);
    await m.reg.sweep();
    assert.equal(m.reg.poll(q.queued.ticket, b.install).result, 'queued', `still following at ${t + 30000} ms`);
  }
  m.advance(30000);
  const r = m.reg.poll(q.queued.ticket, b.install);
  assert.deepEqual([r.result, r.code], ['error', 'FOLLOW_TIMEOUT']);
  assert.equal(m.reg.poll(q.queued.ticket, b.install), null, 'answered once, then gone');

  const short = makeRegistry({ followWindowMs: 5000 });
  const c = player();
  const d = follower(c);
  const q2 = await short.reg.join(d);
  assert.equal(q2.queued.expires_in_sec, 5);
  short.advance(5000);
  await short.reg.sweep();
  const r2 = short.reg.poll(q2.queued.ticket, d.install);
  assert.deepEqual([r2.result, r2.code], ['error', 'FOLLOW_TIMEOUT']);
  // The inviter quickplays only now: nobody is waiting on them.
  const s = await seatByQuickplay(short, c);
  assert.equal(s.lobby.seats.size, 1);
});

test('only live followers come along: one who stopped polling is dropped after 60 s and takes no seat', async () => {
  const m = makeRegistry();
  const someone = player();
  const { lobby } = await seatByQuickplay(m, someone);
  const a = player();
  const live = follower(a);
  const gone = follower(a);
  const ql = await m.reg.join(live);
  const qg = await m.reg.join(gone);
  m.advance(TICKET_TTL_MS / 2);
  m.reg.poll(ql.queued.ticket, live.install);
  await report(m, lobby, 'PREGAME');
  m.advance(TICKET_TTL_MS / 2 + 1);
  await report(m, lobby, 'PREGAME');
  await m.reg.sweep();
  assert.equal(m.reg.poll(qg.queued.ticket, gone.install), null, 'the unpolled follow ticket is dropped');
  assert.equal((await m.reg.join(a)).result, 'ok');
  assert.equal(m.reg.poll(ql.queued.ticket, live.install).result, 'ok');
  assert.equal(lobby.seats.size, 3, 'someone, a and the live follower');
});

test('an admitted follower who does not collect within the hold loses the seat and follows again', async () => {
  const m = makeRegistry();
  const someone = player();
  const { lobby } = await seatByQuickplay(m, someone);
  const a = player();
  const b = follower(a);
  const q = await m.reg.join(b);
  assert.equal((await m.reg.join(a)).result, 'ok');
  assert.equal(lobby.seats.size, 3);
  m.advance(ADMITTED_HOLD_MS + 1);
  await m.reg.sweep();
  // The hold lapsed; the inviter still holds a seat there, so the sweep seats b again at once.
  const p = m.reg.poll(q.queued.ticket, b.install);
  assert.equal(p.result, 'ok');
  assert.equal(tokenOf(p.data, m.clock.t).lobby, lobby.id);
});

test('quickplay with followers: only a public lobby with seats for 1 + followers, else a new one for all of them', async () => {
  const m = makeRegistry();
  const x = player();
  const { lobby: crowded } = await seatByQuickplay(m, x);
  await report(m, crowded, 'PREGAME', { bots: 2 });
  const a = player();
  const b = follower(a);
  const q = await m.reg.join(b);
  // crowded has one seat left: a solo player would get it, a and b need two.
  const ra = await m.reg.join(a);
  assert.equal(ra.result, 'queued', 'not placed in a lobby without room for the follower');
  assert.equal(m.host.started.length, 2, 'a lobby spawned for a and b');
  const fresh = bootingLobbies(m.reg)[0];
  assert.equal(m.reg.poll(q.queued.ticket, b.install).queued.kind, 'follow');
  await m.reg.heartbeat(fresh.id, beat(fresh, 'PREGAME'));
  const pa = m.reg.poll(ra.queued.ticket, a.install);
  const pb = m.reg.poll(q.queued.ticket, b.install);
  assert.deepEqual([pa.result, pb.result], ['ok', 'ok']);
  assert.equal(tokenOf(pa.data, m.clock.t).lobby, fresh.id);
  assert.equal(tokenOf(pb.data, m.clock.t).lobby, fresh.id);
  assert.equal(crowded.seats.size, 1, 'the crowded lobby was passed by');
  // A solo player still takes the crowded lobby's last seat.
  const solo = await m.reg.join(player());
  assert.equal(tokenOf(solo.data, m.clock.t).lobby, crowded.id);
});

test('quickplay with followers: a lobby with room for all of them seats them together at once', async () => {
  const m = makeRegistry();
  const x = player();
  const { lobby } = await seatByQuickplay(m, x);
  const a = player();
  const b = follower(a);
  const c = follower(a);
  const qb = await m.reg.join(b);
  const qc = await m.reg.join(c);
  const ra = await m.reg.join(a);
  assert.equal(ra.result, 'ok');
  assert.equal(tokenOf(ra.data, m.clock.t).lobby, lobby.id);
  assert.equal(m.reg.poll(qb.queued.ticket, b.install).result, 'ok');
  assert.equal(m.reg.poll(qc.queued.ticket, c.install).result, 'ok');
  assert.equal(lobby.seats.size, 4);
});

test('quickplay with followers: followers on another protocol do not count, and are told LOBBY_WRONG_VERSION', async () => {
  const m = makeRegistry({ entries: [manifestEntry(17, FP_A), manifestEntry(17, FP_B)] });
  const x = player();
  const { lobby } = await seatByQuickplay(m, x);
  await report(m, lobby, 'PREGAME', { bots: 2 });
  const a = player();
  const other = follower(a, { fp: FP_B });
  const q = await m.reg.join(other);
  assert.equal(q.queued.kind, 'follow');
  const ra = await m.reg.join(a);
  assert.equal(ra.result, 'ok', 'one seat is enough for a: the follower cannot play there anyway');
  assert.equal(tokenOf(ra.data, m.clock.t).lobby, lobby.id);
  assert.equal(m.reg.poll(q.queued.ticket, other.install).code, 'LOBBY_WRONG_VERSION');
});

test('quickplay with followers while everyone queues: the spawn counts the followers', async () => {
  const m = makeRegistry();
  m.host.busy = new Set(ENV.GAME_PORTS);
  const a = player();
  const fs = [follower(a), follower(a), follower(a)];
  const qs = [];
  for (const f of fs) qs.push(await m.reg.join(f));
  const ra = await m.reg.join(a);
  const solo = player();
  const rs = await m.reg.join(solo);
  assert.deepEqual([ra.result, rs.result], ['queued', 'queued']);
  m.host.busy = new Set();
  await m.reg.sweep();
  assert.equal(m.host.started.length, 2, '4 for a and the followers, 1 for the solo player: two lobbies');
  for (const l of bootingLobbies(m.reg)) await m.reg.heartbeat(l.id, beat(l, 'PREGAME'));
  const la = tokenOf(m.reg.poll(ra.queued.ticket, a.install).data, m.clock.t).lobby;
  for (let i = 0; i < fs.length; i++) {
    const p = m.reg.poll(qs[i].queued.ticket, fs[i].install);
    assert.equal(p.result, 'ok', `follower ${i}`);
    assert.equal(tokenOf(p.data, m.clock.t).lobby, la);
  }
  const ls = tokenOf(m.reg.poll(rs.queued.ticket, solo.install).data, m.clock.t).lobby;
  assert.notEqual(ls, la);
});

test('followers of a follower come along; a follower who joins anything else stops following', async () => {
  const m = makeRegistry();
  const someone = player();
  const { lobby } = await seatByQuickplay(m, someone);
  const a = player();
  const b = follower(a);
  const c = follower(b);
  const qb = await m.reg.join(b);
  const qc = await m.reg.join(c);
  assert.equal(qc.queued.message, `Waiting for ${b.uname} to start a match...`);
  assert.equal((await m.reg.join(a)).result, 'ok');
  assert.equal(tokenOf(m.reg.poll(qb.queued.ticket, b.install).data, m.clock.t).lobby, lobby.id);
  assert.equal(tokenOf(m.reg.poll(qc.queued.ticket, c.install).data, m.clock.t).lobby, lobby.id);

  const d = player();
  const e = follower(d);
  const qe = await m.reg.join(e);
  assert.equal((await m.reg.join({ ...e, mode: 'quickplay', inviter: null })).result, 'queued', 'the lobby is full now');
  assert.equal(m.reg.poll(qe.queued.ticket, e.install), null, 'one ticket per player: the follow went');
});

test('a follow is cancelled by DELETE; follow tickets do not count against lobby_queue_max', async () => {
  const m = makeRegistry();
  m.view.server.lobby_queue_max = 1;
  const a = player();
  const b = follower(a);
  const c = follower(a);
  const qb = await m.reg.join(b);
  assert.equal((await m.reg.join(c)).result, 'queued');
  m.host.busy = new Set(ENV.GAME_PORTS);
  assert.equal((await m.reg.join(player())).result, 'queued', 'the one capped place is still free');
  assert.equal((await m.reg.join(player())).code, 'NO_CAPACITY');
  assert.equal(m.reg.leave(qb.queued.ticket, 'another-install').code, 'QUEUE_TICKET_INVALID');
  assert.equal(m.reg.leave(qb.queued.ticket, b.install).result, 'ok');
  assert.equal(m.reg.poll(qb.queued.ticket, b.install), null);
});

test('the inviter\'s account is deleted: its followers learn INVITE_INVALID; a lobby wait on an ended match says so', async () => {
  const m = makeRegistry();
  const a = player();
  const b = follower(a);
  const q = await m.reg.join(b);
  await m.reg.releasePlayer(a.uid);
  const r = m.reg.poll(q.queued.ticket, b.install);
  assert.deepEqual([r.result, r.code], ['error', 'INVITE_INVALID']);

  const x = player();
  const { lobby } = await seatByQuickplay(m, x);
  await report(m, lobby, 'INGAME');
  const y = follower(x);
  const qy = await m.reg.join(y);
  assert.equal(qy.queued.kind, 'lobby');
  m.host.exit(lobby.id, 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  const p = m.reg.poll(qy.queued.ticket, y.install);
  assert.deepEqual([p.result, p.code], ['error', 'LOBBY_NOT_FOUND']);
  assert.match(p.opts.message, /^That match has ended\./);
});

test('join_user refuses the caller\'s own invite, and UPDATE_REQUIRED / SERVER_BEHIND route as the other modes', async () => {
  const m = makeRegistry({ entries: [manifestEntry(16, FP_A, 'retired'), manifestEntry(17, FP_A)] });
  const a = player();
  const self = await m.reg.join({ ...a, mode: 'join_user', inviter: { uid: a.uid, uname: a.uname } });
  assert.deepEqual([self.result, self.code], ['error', 'VALIDATION']);
  assert.equal((await m.reg.join(follower(a, { wire: 16 }))).code, 'UPDATE_REQUIRED');
  assert.equal((await m.reg.join(follower(a, { wire: 18 }))).code, 'SERVER_BEHIND', 'a follow on a protocol this box cannot run');
  // Seated already, the inviter's lobby needs no manifest entry of its own: a seat as join_private would give.
  const x = player();
  const { lobby } = await seatByQuickplay(m, x);
  m.manifest.entries = [];
  const r = await m.reg.join(follower(x));
  assert.equal(r.result, 'ok');
  assert.equal(tokenOf(r.data, m.clock.t).lobby, lobby.id);
});

test('the guest cull passes a follower by, as any player holding a ticket', async () => {
  const m = makeRegistry();
  const a = player();
  const b = follower(a);
  await m.reg.join(b);
  assert.equal(m.reg.holds(b.uid), true);
  assert.equal(m.reg.holds(a.uid), false, 'an inviter holds nothing until they join');
});
