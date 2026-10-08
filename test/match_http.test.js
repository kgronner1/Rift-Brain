'use strict';
// Contract tests for POST /v1/match/join and /v1/queue/:ticket (spec 4.10, M4) over HTTP, with no database: every
// outcome in the spec's table, in the 4.2 envelope, and no join token in any log line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { signSession, verify } = require('../src/auth/tokens');
const { CODES } = require('../src/contract/codes');
const { SESSION_KEY, JOIN_KEY, FP_A, FP_B, T0, ENV, manifestEntry, makeRegistry, beat, quietLogger } = require('./match_fixture');

const USERS = { 7: 'nova', 8: 'vega', 9: 'rigel', 10: 'deneb', 11: 'altair', 12: 'sirius' };

function headers(extra = {}) {
  return {
    'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '17', 'X-RJ-Wire-Fp': FP_A, 'X-RJ-Env': 'dev',
    'X-RJ-Platform': 'android', 'X-RJ-Install': 'install-1', ...extra,
  };
}

async function start(t, opts = {}) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const logger = quietLogger();
  const m = makeRegistry({ logger, ...opts });
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(m.view);
  const now = () => m.clock.t;
  const findUser = async (uid) => (USERS[uid] ? { user_id: uid, username: USERS[uid] } : null);
  const app = createPublicApp(null, { v1: { env: { ...ENV, SESSION_KEY }, remote, now, match: m.reg, findUser } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = (uid) => signSession({ uid, env: 'dev', nowSec: Math.floor(m.clock.t / 1000), keyHex: SESSION_KEY }).token;
  const call = async (method, path, { uid = 7, body, hdr = {} } = {}) => {
    const h = headers(hdr);
    if (uid) h.Authorization = `Bearer ${session(uid)}`;
    const init = { method, headers: h };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    return { status: r.status, body: await r.json(), ref: r.headers.get('X-RJ-Ref') };
  };
  const join = (body, o = {}) => call('POST', '/v1/match/join', { ...o, body });
  return { ...m, call, join, lines, logger };
}

// An error answer: the envelope, the registry's retry/scope/action, the status.
function assertError(r, code, { scope } = {}) {
  assert.equal(r.body.result, 'error', JSON.stringify(r.body));
  const e = r.body.error;
  assert.equal(e.code, code);
  assert.equal(r.status, CODES[code].status);
  assert.deepEqual(e.retry, CODES[code].retry);
  assert.equal(e.scope, scope || CODES[code].scope);
  assert.equal(e.action.kind, CODES[code].action.kind);
  assert.ok(e.message.length > 0 && e.message.length <= 280);
  assert.equal(e.ref, r.ref);
}

function onlyLobby(reg) {
  return [...reg.lobbies.values()][0];
}

test('join: queued while a lobby boots (202, kind lobby), then the poll answers ok with a verifiable token', async (t) => {
  const s = await start(t);
  const q = await s.join({ mode: 'quickplay' });
  assert.equal(q.status, 202);
  assert.equal(q.body.result, 'queued');
  const qd = q.body.queued;
  assert.deepEqual(Object.keys(qd).sort(), ['eta_sec', 'expires_in_sec', 'kind', 'message', 'poll_after_ms', 'position', 'ticket']);
  assert.equal(qd.kind, 'lobby');
  assert.ok(qd.poll_after_ms >= 800 && qd.poll_after_ms <= 3600);

  const pending = await s.call('GET', `/v1/queue/${qd.ticket}`, { uid: 0 });
  assert.equal(pending.status, 202);
  const lobby = onlyLobby(s.reg);
  await s.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const ok = await s.call('GET', `/v1/queue/${qd.ticket}`, { uid: 0 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result, 'ok');
  assert.equal(ok.body.data.host, 'play.example.test');
  assert.equal(ok.body.data.port, 8100);
  const v = verify(ok.body.data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(s.clock.t / 1000) });
  assert.ok(v.ok);
  assert.equal(v.payload.uid, 7);
  assert.equal(v.payload.uname, 'nova');

  const direct = await s.join({ mode: 'quickplay' }, { uid: 8, hdr: { 'X-RJ-Install': 'install-2' } });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.result, 'ok');
  assert.deepEqual(Object.keys(direct.body.data).sort(), ['host', 'join_token', 'port']);

  const all = s.lines.join('\n') + s.logger.lines.join('\n');
  assert.match(all, /\[v1\] r-[0-9a-f]+ POST \/v1\/match\/join 200/, 'the log capture works: the join\'s own line is there');
  assert.match(all, /\[match\] lobby [0-9a-f]+ spawned/);
  for (const tok of [ok.body.data.join_token, direct.body.data.join_token]) {
    assert.ok(!all.includes(tok), 'a join token reached a log line');
    assert.ok(!all.includes(tok.split('.')[1]), 'a join token signature reached a log line');
  }
  assert.ok(!all.includes(JOIN_KEY), 'JOIN_KEY reached a log line');
});

test('join: create_private then join_private ok, LOBBY_NOT_FOUND, LOBBY_FULL, LOBBY_WRONG_VERSION', async (t) => {
  const s = await start(t, { entries: [manifestEntry(17, FP_A), manifestEntry(17, FP_B)] });
  const c = await s.join({ mode: 'create_private' });
  assert.equal(c.body.result, 'queued');
  const lobby = onlyLobby(s.reg);
  await s.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const host = await s.call('GET', `/v1/queue/${c.body.queued.ticket}`, { uid: 0 });
  assert.equal(host.body.result, 'ok');
  const code = host.body.data.private_code;
  assert.match(code, /^[A-Z]{4}$/);

  assertError(await s.join({ mode: 'join_private', code: code === 'QQQQ' ? 'XXXX' : 'QQQQ' }, { uid: 8 }), 'LOBBY_NOT_FOUND');
  assertError(await s.join({ mode: 'join_private', code }, { uid: 8, hdr: { 'X-RJ-Wire-Fp': FP_B } }), 'LOBBY_WRONG_VERSION');
  for (const uid of [8, 9, 10]) {
    const r = await s.join({ mode: 'join_private', code }, { uid });
    assert.equal(r.body.result, 'ok');
    assert.equal(r.body.data.private_code, code);
  }
  assertError(await s.join({ mode: 'join_private', code }, { uid: 11 }), 'LOBBY_FULL');
});

test('join: NO_CAPACITY when the lobby-wait queue is at lobby_queue_max', async (t) => {
  const s = await start(t);
  s.host.busy = new Set(ENV.GAME_PORTS);
  s.view.server.lobby_queue_max = 1;
  assert.equal((await s.join({ mode: 'quickplay' })).body.result, 'queued');
  assertError(await s.join({ mode: 'quickplay' }, { uid: 8 }), 'NO_CAPACITY');
});

test('join: SERVER_BEHIND and UPDATE_REQUIRED from the client\'s wire; UPDATE_REQUIRED and MAINTENANCE from the gates', async (t) => {
  const s = await start(t, { entries: [manifestEntry(16, FP_A, 'retired'), manifestEntry(17, FP_A)] });
  assertError(await s.join({ mode: 'quickplay' }, { hdr: { 'X-RJ-Wire': '18' } }), 'SERVER_BEHIND');
  assertError(await s.join({ mode: 'quickplay' }, { hdr: { 'X-RJ-Wire-Fp': FP_B } }), 'SERVER_BEHIND');
  assertError(await s.join({ mode: 'quickplay' }, { hdr: { 'X-RJ-Wire': '16' } }), 'UPDATE_REQUIRED', { scope: 'multiplayer' });
  s.view.gates.min_wire = 18;
  assertError(await s.join({ mode: 'quickplay' }), 'UPDATE_REQUIRED', { scope: 'multiplayer' });
  s.view.gates.min_wire = 1;
  s.view.gates.min_build_multiplayer = { default: 29612346 };
  assertError(await s.join({ mode: 'quickplay' }), 'UPDATE_REQUIRED', { scope: 'multiplayer' });
  s.view.gates.min_build_multiplayer = { default: 0 };
  s.view.gates.maintenance = { active: true, scope: 'multiplayer', title: '', message: '', ends_at: null };
  const m = await s.join({ mode: 'quickplay' });
  assert.equal(m.body.error.code, 'MAINTENANCE');
  assert.equal(s.host.started.length, 0);
});

test('join: a session is required; a bad mode is VALIDATION', async (t) => {
  const s = await start(t);
  const r = await s.join({ mode: 'quickplay' }, { uid: 0 });
  assert.equal(r.body.error.code, 'AUTH_REQUIRED');
  assert.equal((await s.join({ mode: 'ranked' })).body.error.code, 'VALIDATION');
  assert.equal((await s.join({ mode: 'join_private' })).body.error.code, 'VALIDATION');
  assert.equal((await s.join({ mode: 'quickplay' }, { uid: 999 })).body.error.code, 'AUTH_INVALID');
});

test('queue: another install, an unknown ticket and a left ticket are QUEUE_TICKET_INVALID; DELETE answers {}', async (t) => {
  const s = await start(t);
  s.host.busy = new Set(ENV.GAME_PORTS);
  const q = await s.join({ mode: 'quickplay' });
  const ticket = q.body.queued.ticket;
  assertError(await s.call('GET', `/v1/queue/${ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-9' } }), 'QUEUE_TICKET_INVALID');
  assertError(await s.call('GET', '/v1/queue/q_doesnotexist000', { uid: 0 }), 'QUEUE_TICKET_INVALID');
  assertError(await s.call('GET', '/v1/queue/nonsense', { uid: 0 }), 'QUEUE_TICKET_INVALID');
  const d = await s.call('DELETE', `/v1/queue/${ticket}`, { uid: 0 });
  assert.equal(d.status, 200);
  assert.deepEqual(d.body, { result: 'ok', data: {} });
  assertError(await s.call('DELETE', `/v1/queue/${ticket}`, { uid: 0 }), 'QUEUE_TICKET_INVALID');
});

test('join: queued during the adoption window after a brain restart', async (t) => {
  const s = await start(t, { bootGraceMs: 30000 });
  const r = await s.join({ mode: 'quickplay' });
  assert.equal(r.body.result, 'queued');
  assert.equal(r.body.queued.kind, 'lobby');
  assert.equal(s.host.started.length, 0);
  assert.ok(T0 > 0);
});
