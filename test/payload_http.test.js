'use strict';
// RJ 587 over HTTP without a database: POST /v1/me/payload/credit and POST /internal/v1/payload/credit. The whole
// call's checks come before any database work (the session, then the entries' shape, then the account), the answer is
// the ledger's, a client's entries go as 'client' and a server's as 'server', and the internal route takes only a
// seated player, answering a deleted one with every entry rejected. The stores are stand-ins; payload.db.test.js
// drives the real ledger.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp, createInternalApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { signSession } = require('../src/auth/tokens');
const { noSuchUserAnswer } = require('../src/storage/payloadLedger');
const { LOBBY_MASTER_KEY, makeRegistry, player, beat, lobbyKey, quietLogger } = require('./match_fixture');

const KEY = 'ef'.repeat(32);
const NOW_MS = Date.UTC(2026, 10, 22, 12, 0, 0);
const NOW_SEC = NOW_MS / 1000;
const GOOD = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '1', 'X-RJ-Wire-Fp': '9f2c4e1a0b7d3c55', 'X-RJ-Env': 'dev',
  'X-RJ-Platform': 'android', 'X-RJ-Install': '6f1c2b8e-0000-4000-8587-000000000001',
};
const RUN = { ref: 'run:abcdefgh', source: 'sp_run', amount: 10 };

function fakePayload() {
  const calls = [];
  return {
    calls,
    async applyPayloadEntries(uid, entries, opts) {
      calls.push([uid, entries, opts.from]);
      return { balance: 77, earned_alltime: 99, entries: entries.map((e) => ({ ref: e.ref, status: 'applied', credited: e.amount })) };
    },
  };
}

function fakeAccounts(live = new Set([7])) {
  const calls = [];
  return { calls, live, async userExists(uid) { calls.push(uid); return live.has(uid); } };
}

async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function send(url, method, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, init);
  return { status: r.status, body: JSON.parse(await r.text()) };
}

function code(r) {
  return r.body.result === 'error' ? r.body.error.code : r.body.result;
}

async function startPublic(t) {
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, () => {});
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(defaultView('dev'));
  const payload = fakePayload();
  const accounts = fakeAccounts();
  const base = await listen(t, createPublicApp(null, { v1: { env: { ENV: 'dev', SESSION_KEY: KEY }, remote, now: () => NOW_MS, accountStore: accounts, payloadStore: payload } }));
  const call = (body, { uid = 7, token } = {}) => {
    const h = { ...GOOD };
    const bearer = token !== undefined ? token : (uid ? signSession({ uid, env: 'dev', nowSec: NOW_SEC, keyHex: KEY }).token : null);
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return send(`${base}/v1/me/payload/credit`, 'POST', { headers: h, body });
  };
  return { call, payload, accounts };
}

test('/v1/me/payload/credit: no session is AUTH_REQUIRED; a bad shape is VALIDATION before any database work', async (t) => {
  const { call, payload, accounts } = await startPublic(t);
  assert.equal(code(await call({ entries: [] }, { uid: null })), 'AUTH_REQUIRED');
  const bad = [
    {}, { entries: null }, { entries: {} }, { entries: 'carry' }, { entries: 3 },
    { entries: Array.from({ length: 33 }, () => RUN) },
    { entries: [RUN, null] }, { entries: [[RUN]] }, { entries: ['run:abcdefgh'] }, { entries: [5] },
  ];
  for (const b of bad) {
    const r = await call(b);
    assert.deepEqual([r.status, code(r)], [400, 'VALIDATION'], JSON.stringify(b).slice(0, 80));
    assert.equal(typeof r.body.error.message, 'string');
  }
  assert.equal(code(await call('[1, 2')), 'VALIDATION', 'a body that is not JSON');
  assert.deepEqual([payload.calls, accounts.calls], [[], []], 'nothing reached the account check or the ledger');
});

test('/v1/me/payload/credit: an account that is gone is AUTH_INVALID; otherwise the ledger answers, as the client', async (t) => {
  const { call, payload, accounts } = await startPublic(t);
  const gone = await call({ entries: [RUN] }, { uid: 9 });
  assert.deepEqual([code(gone), gone.status, gone.body.error.scope], ['AUTH_INVALID', 401, 'account']);
  assert.deepEqual(payload.calls, []);

  const read = await call({ entries: [] });
  assert.deepEqual(read.body, { result: 'ok', data: { balance: 77, earned_alltime: 99, entries: [] } }, 'an empty array is a balance read');
  const full = Array.from({ length: 32 }, (_, i) => ({ ...RUN, ref: `run:abcdefgh${i}` }));
  const r = await call({ entries: full, extra: 'ignored' });
  assert.equal(code(r), 'ok');
  assert.equal(r.body.data.entries.length, 32);
  assert.deepEqual(payload.calls.map(([uid, e, from]) => [uid, e.length, from]), [[7, 0, 'client'], [7, 32, 'client']]);
  assert.deepEqual(accounts.calls, [9, 7, 7]);
});

async function startInternal(t) {
  const m = makeRegistry({ logger: quietLogger() });
  const store = {
    calls: [],
    deleted: new Set(),
    async userExists(uid) { return !this.deleted.has(uid); },
    noSuchUserAnswer,
    async applyPayloadEntries(uid, entries, opts) {
      this.calls.push([uid, entries, opts.from]);
      return { balance: 150, earned_alltime: 150, entries: entries.map((e) => ({ ref: e.ref, status: 'applied', credited: e.amount })) };
    },
  };
  for (const k of ['log', 'warn', 'error']) t.mock.method(console, k, () => {});
  const base = await listen(t, createInternalApp({ env: { LOBBY_MASTER_KEY }, match: m.reg, store }));
  // Two players hold seats; a took theirs (player-joined), b holds only a reservation.
  const a = player();
  const b = player();
  for (const p of [a, b]) {
    const r = await m.reg.join(p);
    const lobby = [...m.reg.lobbies.values()][0];
    if (lobby.state === 'BOOTING') await m.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
    if (r.result === 'queued') m.reg.poll(r.queued.ticket, p.install);
  }
  const lobby = [...m.reg.lobbies.values()][0];
  const seatOf = (uid) => [...lobby.seats].find(([, x]) => x.uid === uid)[0];
  const h = { 'X-RJ-Wire': '17', 'X-RJ-Lobby': lobby.id, 'X-RJ-Lobby-Key': lobbyKey(lobby.id) };
  assert.equal((await send(`${base}/internal/v1/lobby/player-joined`, 'POST', { headers: h, body: { user_id: a.uid, seat: seatOf(a.uid) } })).status, 200);
  const call = (body, headers = h) => send(`${base}/internal/v1/payload/credit`, 'POST', { headers, body });
  return { call, store, a, b, lobby };
}

const ACC = { ref: 'accolade:Ghost', source: 'accolade', amount: 100 };

test('/internal/v1/payload/credit: the lobby key, then {user_id, entries}, then a seat in this lobby', async (t) => {
  const s = await startInternal(t);
  assert.equal((await s.call({ user_id: s.a.uid, entries: [ACC] }, { 'X-RJ-Wire': '17' })).status, 401);
  const other = 'e'.repeat(24);
  const cross = await s.call({ user_id: s.a.uid, entries: [ACC] }, { 'X-RJ-Wire': '17', 'X-RJ-Lobby': other, 'X-RJ-Lobby-Key': lobbyKey(other) });
  assert.deepEqual([cross.status, code(cross)], [403, 'VALIDATION'], 'another lobby cannot credit this lobby\'s player');
  for (const body of [{ entries: [ACC] }, { user_id: '5', entries: [ACC] }, { user_id: 0, entries: [ACC] }, { user_id: s.a.uid },
    { user_id: s.a.uid, entries: [ACC, null] }, { user_id: s.a.uid, entries: Array.from({ length: 33 }, () => ACC) }]) {
    const r = await s.call(body);
    assert.deepEqual([r.status, code(r)], [400, 'VALIDATION'], JSON.stringify(body).slice(0, 80));
  }
  const reserved = await s.call({ user_id: s.b.uid, entries: [ACC] });
  assert.deepEqual([reserved.status, code(reserved), reserved.body.error.message], [403, 'VALIDATION', 'That player has no seat in this lobby.']);
  const never = await s.call({ user_id: 424242, entries: [ACC] });
  assert.equal(never.status, 403);
  assert.deepEqual(s.store.calls, []);

  const r = await s.call({ user_id: s.a.uid, entries: [ACC] });
  assert.deepEqual(r.body, { result: 'ok', data: { balance: 150, earned_alltime: 150, entries: [{ ref: 'accolade:Ghost', status: 'applied', credited: 100 }] } });
  assert.deepEqual(s.store.calls, [[s.a.uid, [ACC], 'server']], 'a game server\'s entries go as the server\'s');
});

test('/internal/v1/payload/credit: a seated player whose account is gone gets every entry rejected, "no such user"', async (t) => {
  const s = await startInternal(t);
  s.store.deleted.add(s.a.uid);
  const entries = [ACC, { ref: 7, source: 'accolade', amount: 50 }];
  const r = await s.call({ user_id: s.a.uid, entries });
  assert.deepEqual(r.body, { result: 'ok', data: { balance: 0, earned_alltime: 0, entries: [
    { ref: 'accolade:Ghost', status: 'rejected', reason: 'no such user' },
    { ref: null, status: 'rejected', reason: 'no such user' },
  ] } });
  assert.deepEqual(s.store.calls, [], 'nothing reaches the ledger');
});
