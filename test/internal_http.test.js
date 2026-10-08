'use strict';
// The internal API (spec 4.11) over HTTP: the lobby-key check, the heartbeat adopting a lobby after a brain restart,
// and match results and accolades accepted only for seated players. Storage is a stand-in here; internal.db.test.js
// drives the same routes against a real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInternalApp } = require('../src/app');
const { LOBBY_MASTER_KEY, FP_A, ENV, makeRegistry, fakeHost, player, beat, lobbyKey, quietLogger } = require('./match_fixture');

function fakeStore() {
  const calls = [];
  return {
    calls,
    async postMatchPlayerStatsUpdate(body) { calls.push(['results', body]); return body.map((p) => ({ user_id: p.user_id, numJumps: 1 })); },
    async playerAccoladesSync(body) { calls.push(['accolades', body]); return { user_accolades: { user_id: body.user_id }, ignored_keys: [] }; },
    async getUserAccolades(uid) { return { Rookie: { earnRate: 50, earned: uid } }; },
    async getPlayerCard(uid) { return uid === 404 ? null : { user_id: uid, equipped_accolade_key: 'Rookie' }; },
  };
}

async function start(t, m = makeRegistry({ logger: quietLogger() })) {
  const lines = [];
  for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, (...a) => lines.push(a.join(' ')));
  const store = fakeStore();
  const app = createInternalApp({ env: { LOBBY_MASTER_KEY }, match: m.reg, store });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/internal/v1`;
  const call = async (method, path, { lobby, key, body } = {}) => {
    const h = { 'X-RJ-Wire': '17' };
    if (lobby) h['X-RJ-Lobby'] = lobby;
    if (lobby || key) h['X-RJ-Lobby-Key'] = key === undefined ? lobbyKey(lobby) : key;
    const init = { method, headers: h };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    return { status: r.status, body: await r.json() };
  };
  return { ...m, call, store, lines };
}

async function seatedLobby(s, n = 1) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const p = player();
    players.push(p);
    const r = await s.reg.join(p);
    const lobby = [...s.reg.lobbies.values()][0];
    if (lobby.state === 'BOOTING') await s.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
    if (r.result === 'queued') s.reg.poll(r.queued.ticket, p.install);
  }
  const lobby = [...s.reg.lobbies.values()][0];
  return { lobby, players };
}

test('every internal route needs the lobby key derived for that lobby id', async (t) => {
  const s = await start(t);
  const { lobby } = await seatedLobby(s);
  const hb = beat(lobby, 'PREGAME');
  const r0 = await s.call('POST', '/lobby/heartbeat', { body: hb });
  assert.equal(r0.status, 401);
  assert.equal(r0.body.error.code, 'AUTH_REQUIRED');
  const other = 'b'.repeat(24);
  assert.equal((await s.call('POST', '/lobby/heartbeat', { lobby: lobby.id, key: lobbyKey(other), body: hb })).status, 401, 'another lobby\'s key');
  assert.equal((await s.call('POST', '/lobby/heartbeat', { lobby: lobby.id, key: 'zz', body: hb })).status, 401);
  assert.equal((await s.call('POST', '/lobby/heartbeat', { lobby: 'short', body: hb })).status, 401);
  assert.equal((await s.call('GET', '/users/7/player-card', { lobby: lobby.id, key: '00'.repeat(32) })).status, 401);
  const ok = await s.call('POST', '/lobby/heartbeat', { lobby: lobby.id, body: hb });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { result: 'ok', data: {} });
  assert.ok(!s.lines.join('\n').includes(lobbyKey(lobby.id)), 'the lobby key reached a log line');
  assert.match(s.lines.join('\n'), /POST \/internal\/v1\/lobby\/heartbeat 401 AUTH_REQUIRED/, 'the log capture works');
});

test('player-joined and player-left; results and accolades only for seated players', async (t) => {
  const s = await start(t);
  const { lobby, players } = await seatedLobby(s, 2);
  const [a, b] = players;
  const seatOf = (uid) => [...lobby.seats].find(([, x]) => x.uid === uid)[0];
  const lobbyOpts = { lobby: lobby.id };

  const wrong = await s.call('POST', '/lobby/player-joined', { ...lobbyOpts, body: { user_id: b.uid, seat: seatOf(a.uid) } });
  assert.equal(wrong.status, 409);
  assert.equal((await s.call('POST', '/lobby/player-joined', { ...lobbyOpts, body: { user_id: a.uid, seat: seatOf(a.uid) } })).status, 200);

  const results = [
    { user_id: a.uid, stats: { numJumps: 3 } },
    { user_id: b.uid, stats: { numJumps: 4 } },
    { user_id: 424242, stats: { numJumps: 99 } },
  ];
  const r = await s.call('POST', '/match/results', { ...lobbyOpts, body: results });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.ignored_user_ids, [b.uid, 424242], 'b holds only a reservation; 424242 never joined');
  assert.deepEqual(s.store.calls[0], ['results', [{ user_id: a.uid, stats: { numJumps: 3 } }]]);
  assert.deepEqual(r.body.data.players, [{ user_id: a.uid, numJumps: 1 }]);

  const acc = await s.call('POST', '/match/accolades', { ...lobbyOpts, body: { user_id: b.uid, accolades: { Rookie: 1 } } });
  assert.equal(acc.status, 403);
  const accOk = await s.call('POST', '/match/accolades', { ...lobbyOpts, body: { user_id: a.uid, accolades: { Rookie: 1 } } });
  assert.deepEqual(accOk.body.data, { user_accolades: { user_id: a.uid }, ignored_keys: [] });

  // Leaving frees the seat, and the player's results from this lobby still count (they played in it).
  assert.equal((await s.call('POST', '/lobby/player-left', { ...lobbyOpts, body: { user_id: a.uid, seat: seatOf(a.uid) } })).status, 200);
  assert.equal(lobby.seats.has(seatOf(b.uid)), true);
  assert.equal([...lobby.seats.values()].some((x) => x.uid === a.uid), false);
  const after = await s.call('POST', '/match/results', { ...lobbyOpts, body: [{ user_id: a.uid, stats: {} }] });
  assert.deepEqual(after.body.data.ignored_user_ids, []);

  // Another lobby's key cannot write for this lobby's players.
  const other = 'c'.repeat(24);
  const cross = await s.call('POST', '/match/results', { lobby: other, body: results });
  assert.deepEqual(cross.body.data.ignored_user_ids, [a.uid, b.uid, 424242]);
});

test('reads: accolades (0 is the global earn rates) and the player card', async (t) => {
  const s = await start(t);
  const id = 'd'.repeat(24);
  assert.deepEqual((await s.call('GET', '/users/0/accolades', { lobby: id })).body.data, { Rookie: { earnRate: 50, earned: 0 } });
  assert.deepEqual((await s.call('GET', '/users/7/player-card', { lobby: id })).body.data, { user_id: 7, equipped_accolade_key: 'Rookie' });
  assert.equal((await s.call('GET', '/users/404/player-card', { lobby: id })).status, 404);
  assert.equal((await s.call('GET', '/users/abc/player-card', { lobby: id })).body.error.code, 'VALIDATION');
  assert.equal((await s.call('GET', '/nope', { lobby: id })).status, 404);
});

test('a brain restart: the new brain verifies and adopts a lobby it never spawned, with its seats', async (t) => {
  const host = fakeHost();
  const clock = { t: Date.UTC(2026, 9, 8, 15, 0, 0) };
  const before = makeRegistry({ host, clock, logger: quietLogger() });
  const p = player();
  const q = await before.reg.join(p);
  const lobby = [...before.reg.lobbies.values()][0];
  await before.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  before.reg.poll(q.queued.ticket, p.install);
  const seat = [...lobby.seats.keys()][0];
  before.reg.playerJoined(lobby.id, { user_id: p.uid, seat });
  const hb = beat(lobby, 'INGAME', { bots: 1 });

  const s = await start(t, makeRegistry({ host, clock, bootGraceMs: 30000, logger: quietLogger() }));
  assert.equal(s.reg.lobbies.size, 0);
  assert.equal((await s.call('POST', '/lobby/player-joined', { lobby: lobby.id, body: { user_id: p.uid, seat } })).body.error.code,
    'LOBBY_NOT_FOUND', 'only a heartbeat adopts');
  const r = await s.call('POST', '/lobby/heartbeat', { lobby: lobby.id, body: hb });
  assert.equal(r.status, 200);
  const adopted = s.reg.lobbies.get(lobby.id);
  assert.deepEqual([adopted.port, adopted.wire, adopted.fp, adopted.state, adopted.bots], [8100, 17, FP_A, 'INGAME', 1]);
  const results = await s.call('POST', '/match/results', { lobby: lobby.id, body: [{ user_id: p.uid, stats: { numJumps: 1 } }] });
  assert.deepEqual(results.body.data.ignored_user_ids, [], 'the adopted seat is a verified seat');

  s.advance(30000);
  await s.reg.sweep();
  assert.deepEqual(host.stopped, [], 'an adopted lobby is not a stray');
  assert.equal(ENV.GAME_PORTS.includes(adopted.port), true);
});
