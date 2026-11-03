'use strict';
// RJ 458, invite links, over HTTP with no database (Wobble Planet specs/invite-links.md, 2.1-2.3, 2.5): the mint's
// checks in order, the public lookup (no X-RJ headers, CORS, its limit, the id kept out of the log), and join_user's
// outcomes in the 4.2 envelope, the follow ticket polled and cancelled at /v1/queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig } = require('../src/config/remote');
const { signSession, verify } = require('../src/auth/tokens');
const { CODES } = require('../src/contract/codes');
const { newInviteId, INVITE_ID_RE } = require('../src/storage/invites');
const { SESSION_KEY, JOIN_KEY, FP_A, ENV, makeRegistry, beat, quietLogger } = require('./match_fixture');

const USERS = { 7: 'nova', 8: 'vega', 9: 'rigel', 10: 'deneb' };
const JOIN_ORIGIN = 'https://join.riftjumpers.space';

function headers(extra = {}) {
  return {
    'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Wire': '17', 'X-RJ-Wire-Fp': FP_A, 'X-RJ-Env': 'dev',
    'X-RJ-Platform': 'android', 'X-RJ-Install': 'install-1', ...extra,
  };
}

// The invites table, in memory, on the test's clock.
function fakeInvites(users) {
  const rows = new Map();
  const calls = { mint: 0, find: 0 };
  return {
    rows,
    calls,
    async mintInvite(uid, { now }) {
      calls.mint++;
      if (!users[uid]) return null;
      const id = newInviteId();
      rows.set(id, { user_id: uid, expiresAt: now + 86400 * 1000 });
      return { id, expires_in: 86400 };
    },
    async findInvite(id, { now }) {
      calls.find++;
      const r = rows.get(id);
      if (!r || r.expiresAt <= now || !users[r.user_id]) return null;
      return { id, user_id: r.user_id, username: users[r.user_id], expires_in: Math.ceil((r.expiresAt - now) / 1000) };
    },
  };
}

async function start(t, { env = {}, flags = {}, users = { ...USERS }, registry = {} } = {}) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  const logger = quietLogger();
  const m = makeRegistry({ logger, ...registry });
  Object.assign(m.view.flags, flags);
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(m.view);
  const now = () => m.clock.t;
  const invites = fakeInvites(users);
  const findUser = async (uid) => (users[uid] ? { user_id: uid, username: users[uid] } : null);
  const fullEnv = { ...ENV, SESSION_KEY, JOIN_URL_BASE: 'https://join.riftjumpers.space/dev', ...env };
  const app = createPublicApp(null, { v1: { env: fullEnv, remote, now, match: m.reg, findUser, inviteStore: invites } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = (uid) => signSession({ uid, env: 'dev', nowSec: Math.floor(m.clock.t / 1000), keyHex: SESSION_KEY }).token;
  const call = async (method, path, { uid = 7, body, hdr, bare = false } = {}) => {
    const h = bare ? { ...(hdr || {}) } : headers(hdr);
    if (uid) h.Authorization = `Bearer ${session(uid)}`;
    const init = { method, headers: h };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const r = await fetch(base + path, init);
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers, ref: r.headers.get('X-RJ-Ref') };
  };
  const mint = (uid = 7) => call('POST', '/v1/me/invites', { uid, body: {} });
  const join = (body, o = {}) => call('POST', '/v1/match/join', { ...o, body });
  return { ...m, call, mint, join, lines, logger, invites, users, base };
}

function assertError(r, code, { message } = {}) {
  assert.equal(r.body.result, 'error', JSON.stringify(r.body));
  const e = r.body.error;
  assert.equal(e.code, code);
  assert.equal(r.status, CODES[code].status);
  assert.equal(e.retry.kind, CODES[code].retry.kind);
  assert.equal(e.scope, CODES[code].scope);
  assert.equal(e.action.kind, CODES[code].action.kind);
  assert.equal(e.ref, r.ref);
  if (message !== undefined) assert.equal(e.message, message);
}

test('mint: ok {invite: {id, url, expires_in}}, a new id every call, the url from JOIN_URL_BASE', async (t) => {
  const s = await start(t);
  const a = await s.mint();
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.body.data), ['invite']);
  const inv = a.body.data.invite;
  assert.deepEqual(Object.keys(inv).sort(), ['expires_in', 'id', 'url']);
  assert.match(inv.id, /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/);
  assert.equal(inv.url, `https://join.riftjumpers.space/dev/${inv.id}`);
  assert.equal(inv.expires_in, 86400);
  const b = await s.mint();
  assert.notEqual(b.body.data.invite.id, inv.id);
  assert.equal(s.invites.rows.size, 2);

  const alpha = await start(t, { env: { JOIN_URL_BASE: 'https://join.riftjumpers.space' } });
  const c = await alpha.mint();
  assert.equal(c.body.data.invite.url, `https://join.riftjumpers.space/${c.body.data.invite.id}`);
});

test('mint: in order, AUTH_REQUIRED, flags.invites off (VALIDATION, nothing spent), RATE_LIMITED 30 an hour, AUTH_INVALID', async (t) => {
  const s = await start(t, { flags: { invites: false } });
  assertError(await s.call('POST', '/v1/me/invites', { uid: 0, body: {} }), 'AUTH_REQUIRED');
  for (let i = 0; i < 40; i++) {
    assertError(await s.mint(), 'VALIDATION', { message: 'Invites are off right now. Share your lobby code instead.' });
  }
  assert.equal(s.invites.calls.mint, 0);
  s.view.flags.invites = true;
  for (let i = 0; i < 30; i++) assert.equal((await s.mint()).body.result, 'ok', `mint ${i + 1}`);
  const over = await s.mint();
  assertError(over, 'RATE_LIMITED');
  assert.ok(over.body.error.retry.after_ms > 59 * 60 * 1000, 'the window is an hour');
  assert.equal((await s.mint(8)).body.result, 'ok', 'per account');
  s.advance(60 * 60 * 1000);
  assert.equal((await s.mint()).body.result, 'ok', 'a new hour');
  delete s.users[9];
  assertError(await s.mint(9), 'AUTH_INVALID');
});

test('mint: no JOIN_URL_BASE is INTERNAL, logged', async (t) => {
  const s = await start(t, { env: { JOIN_URL_BASE: null } });
  assertError(await s.mint(), 'INTERNAL');
  assert.ok(s.lines.some((l) => /JOIN_URL_BASE is not set/.test(l)));
});

test('lookup: no X-RJ headers needed; valid names the inviter; unknown, expired, malformed and deleted are {valid: false}', async (t) => {
  const s = await start(t);
  const id = (await s.mint()).body.data.invite.id;
  const r = await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'ok', data: { valid: true, inviter: { username: 'nova' }, expires_in: 86400 } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.ref, /^r-[0-9a-f]+$/);
  const upper = await s.call('GET', `/v1/invites/${id.toUpperCase()}`, { uid: 0, bare: true });
  assert.equal(upper.body.data.valid, true, 'a link a chat app capitalised still works');
  const withHeaders = await s.call('GET', `/v1/invites/${id}`, { uid: 7 });
  assert.equal(withHeaders.body.data.valid, true, 'the client calls it with its headers and a session');

  const finds = s.invites.calls.find;
  for (const bad of ['short', 'O0l1iOOOOO', `${id}x`, '%20']) {
    const b = await s.call('GET', `/v1/invites/${bad}`, { uid: 0, bare: true });
    assert.deepEqual(b.body, { result: 'ok', data: { valid: false } }, bad);
  }
  assert.equal(s.invites.calls.find, finds, 'a malformed id never reaches the database');
  const unknown = newInviteId();
  assert.deepEqual((await s.call('GET', `/v1/invites/${unknown}`, { uid: 0, bare: true })).body.data, { valid: false });

  s.advance(86400 * 1000 - 1500);
  assert.equal((await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true })).body.data.expires_in, 2);
  s.advance(1500);
  assert.deepEqual((await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true })).body.data, { valid: false }, 'expired');

  const id2 = (await s.mint(8)).body.data.invite.id;
  delete s.users[8];
  assert.deepEqual((await s.call('GET', `/v1/invites/${id2}`, { uid: 0, bare: true })).body.data, { valid: false }, 'inviter deleted');

  const id3 = (await s.mint(7)).body.data.invite.id;
  s.view.flags.invites = false;
  assert.equal((await s.call('GET', `/v1/invites/${id3}`, { uid: 0, bare: true })).body.data.valid, true, 'the lookup answers with the flag off');
});

test('lookup: CORS allows the link domain alone, GET only; a preflight answers 204', async (t) => {
  const s = await start(t);
  const id = (await s.mint()).body.data.invite.id;
  const ok = await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true, hdr: { Origin: JOIN_ORIGIN } });
  assert.equal(ok.headers.get('access-control-allow-origin'), JOIN_ORIGIN);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'GET');
  assert.match(ok.headers.get('vary') || '', /Origin/);
  for (const origin of ['https://evil.example', 'https://join.riftjumpers.space.evil.example', 'http://join.riftjumpers.space']) {
    const r = await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true, hdr: { Origin: origin } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, origin);
    assert.equal(r.body.data.valid, true, 'answered all the same: CORS is the browser\'s to enforce');
  }
  const pre = await s.call('OPTIONS', `/v1/invites/${id}`, {
    uid: 0, bare: true, hdr: { Origin: JOIN_ORIGIN, 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), JOIN_ORIGIN);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET');
  // The origins come from the environment (JOIN_PAGE_ORIGINS): a page hosted elsewhere is a setting, not a change.
  const moved = await start(t, { env: { JOIN_PAGE_ORIGINS: ['https://riftjumpers.space', 'https://www.riftjumpers.space'] } });
  const mid = (await moved.mint()).body.data.invite.id;
  for (const [origin, allowed] of [['https://www.riftjumpers.space', true], ['https://riftjumpers.space', true], [JOIN_ORIGIN, false]]) {
    const r = await moved.call('GET', `/v1/invites/${mid}`, { uid: 0, bare: true, hdr: { Origin: origin } });
    assert.equal(r.headers.get('access-control-allow-origin'), allowed ? origin : null, origin);
  }
  // Any other method is not the public route: without the client's headers the gates answer.
  const post = await s.call('POST', `/v1/invites/${id}`, { uid: 0, bare: true, body: {} });
  assertError(post, 'ENV_MISMATCH');
  assert.equal(post.headers.get('access-control-allow-origin'), null);
});

test('lookup: RATE_LIMITED past 60 a minute per IP, readable by the page; the id never reaches a log line', async (t) => {
  const s = await start(t);
  const id = (await s.mint()).body.data.invite.id;
  for (let i = 0; i < 60; i++) assert.equal((await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true })).status, 200);
  const over = await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true, hdr: { Origin: JOIN_ORIGIN } });
  assertError(over, 'RATE_LIMITED');
  assert.equal(over.headers.get('access-control-allow-origin'), JOIN_ORIGIN, 'the page can read why');
  s.advance(60 * 1000);
  assert.equal((await s.call('GET', `/v1/invites/${id}`, { uid: 0, bare: true })).status, 200);

  const all = s.lines.join('\n') + s.logger.lines.join('\n');
  assert.match(all, /\[v1\] r-[0-9a-f]+ GET \/v1\/invites\/:id 200/, 'the measurement: the lookup\'s own line is there');
  assert.match(all, /\[v1\] r-[0-9a-f]+ POST \/v1\/me\/invites 200/);
  assert.ok(!all.includes(id), 'an invite id reached a log line');
});

test('join_user: VALIDATION (flag off, no invite), INVITE_INVALID (unknown, expired, malformed), VALIDATION (own invite)', async (t) => {
  const s = await start(t);
  const id = (await s.mint(7)).body.data.invite.id;
  s.view.flags.invites = false;
  assertError(await s.join({ mode: 'join_user', invite: id }, { uid: 8 }), 'VALIDATION', { message: 'Invites are off right now. Share your lobby code instead.' });
  s.view.flags.invites = true;
  assertError(await s.join({ mode: 'join_user' }, { uid: 8 }), 'VALIDATION');
  assertError(await s.join({ mode: 'join_user', invite: 12 }, { uid: 8 }), 'VALIDATION');
  for (const bad of [newInviteId(), 'nope', '']) {
    assertError(await s.join({ mode: 'join_user', invite: bad }, { uid: 8 }), 'INVITE_INVALID', { message: 'This invite has expired; ask for a new one.' });
  }
  assertError(await s.join({ mode: 'join_user', invite: id }, { uid: 7 }), 'VALIDATION', { message: "That's your own invite." });
  s.advance(86400 * 1000);
  assertError(await s.join({ mode: 'join_user', invite: id }, { uid: 8 }), 'INVITE_INVALID');
  assert.ok(INVITE_ID_RE.test(id));
});

test('join_user: queued kind follow naming the inviter; the inviter quickplays; the follower\'s poll answers ok with a token for that lobby', async (t) => {
  const s = await start(t);
  const id = (await s.mint(7)).body.data.invite.id;
  const q = await s.join({ mode: 'join_user', invite: id.toUpperCase() }, { uid: 8, hdr: { 'X-RJ-Install': 'install-8' } });
  assert.equal(q.status, 202);
  assert.equal(q.body.result, 'queued');
  const qd = q.body.queued;
  assert.deepEqual([qd.kind, qd.expires_in_sec, qd.message], ['follow', 600, 'Waiting for nova to start a match...']);
  const pending = await s.call('GET', `/v1/queue/${qd.ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-8' } });
  assert.equal(pending.body.queued.kind, 'follow');

  const a = await s.join({ mode: 'quickplay' }, { uid: 7 });
  assert.equal(a.body.result, 'queued');
  const lobby = [...s.reg.lobbies.values()][0];
  await s.reg.heartbeat(lobby.id, beat(lobby, 'PREGAME'));
  const pa = await s.call('GET', `/v1/queue/${a.body.queued.ticket}`, { uid: 0 });
  const pb = await s.call('GET', `/v1/queue/${qd.ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-8' } });
  assert.deepEqual([pa.body.result, pb.body.result], ['ok', 'ok']);
  const tb = verify(pb.body.data.join_token, { keyHex: JOIN_KEY, typ: 'j', env: 'dev', nowSec: Math.floor(s.clock.t / 1000) });
  assert.ok(tb.ok);
  assert.deepEqual([tb.payload.uid, tb.payload.uname, tb.payload.lobby], [8, 'vega', lobby.id]);

  // The inviter seated with room: a third friend's join_user is ok at once.
  const c = await s.join({ mode: 'join_user', invite: id }, { uid: 9, hdr: { 'X-RJ-Install': 'install-9' } });
  assert.equal(c.body.result, 'ok');
  assert.deepEqual(Object.keys(c.body.data).sort(), ['host', 'join_token', 'port']);
});

test('join_user: a follow times out with FOLLOW_TIMEOUT at /v1/queue (the window from the registry); DELETE cancels one', async (t) => {
  const s = await start(t, { registry: { followWindowMs: 20 * 1000 } });
  const id = (await s.mint(7)).body.data.invite.id;
  const q = await s.join({ mode: 'join_user', invite: id }, { uid: 8, hdr: { 'X-RJ-Install': 'install-8' } });
  assert.equal(q.body.queued.expires_in_sec, 20);
  s.advance(20 * 1000);
  const r = await s.call('GET', `/v1/queue/${q.body.queued.ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-8' } });
  assertError(r, 'FOLLOW_TIMEOUT');
  assertError(await s.call('GET', `/v1/queue/${q.body.queued.ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-8' } }), 'QUEUE_TICKET_INVALID');

  const q2 = await s.join({ mode: 'join_user', invite: id }, { uid: 9, hdr: { 'X-RJ-Install': 'install-9' } });
  const d = await s.call('DELETE', `/v1/queue/${q2.body.queued.ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-9' } });
  assert.deepEqual(d.body, { result: 'ok', data: {} });
  assertError(await s.call('GET', `/v1/queue/${q2.body.queued.ticket}`, { uid: 0, hdr: { 'X-RJ-Install': 'install-9' } }), 'QUEUE_TICKET_INVALID');
});

test('join_user is a multiplayer route: the multiplayer floor and maintenance answer first', async (t) => {
  const s = await start(t);
  const id = (await s.mint(7)).body.data.invite.id;
  s.view.gates.min_build_multiplayer = { default: 29612346 };
  assertError(await s.join({ mode: 'join_user', invite: id }, { uid: 8 }), 'UPDATE_REQUIRED');
  assert.equal((await s.mint(7)).body.result, 'ok', 'minting is not: a share still works below the multiplayer floor');
  s.view.gates.min_build_multiplayer = { default: 0 };
  s.view.gates.maintenance = { active: true, scope: 'multiplayer', title: '', message: '', ends_at: null };
  assert.equal((await s.join({ mode: 'join_user', invite: id }, { uid: 8 })).body.error.code, 'MAINTENANCE');
  assert.equal(s.invites.calls.find, 0, 'refused before the invite is read');
});
