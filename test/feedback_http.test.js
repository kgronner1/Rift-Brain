'use strict';
// POST /v1/feedback (RJ 488) over HTTP, with a stand-in for the feedback table: who sent it, the cleaning, a repeat
// id, the limits, the gates that apply and the ones that don't. feedback.db.test.js drives the real table.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createRemoteConfig, defaultView } = require('../src/config/remote');
const { signSession, sign } = require('../src/auth/tokens');
const { WINDOW_MS, DAY_MS } = require('../src/middleware/rateLimit');
const { cleanEntry, capContext, cutCodePoints, CONTEXT_MAX_BYTES } = require('../src/feedback/entry');

const KEY = 'cd'.repeat(32);
const OTHER_KEY = 'ef'.repeat(32);
const T0 = Date.UTC(2026, 9, 14, 18, 0, 0);
const INSTALL = '6F1C2B8E-0000-4000-8000-000000000001';
const HEADERS = {
  'X-RJ-Api': '1', 'X-RJ-Build': '29612345', 'X-RJ-Env': 'dev', 'X-RJ-Platform': 'Android', 'X-RJ-Install': INSTALL,
};
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function fakeStore(users = { 7: 'Pilot_Seven' }) {
  const rows = new Map();
  return {
    rows,
    async findFeedbackUser(uid) {
      return users[uid] ? { user_id: uid, username: users[uid] } : null;
    },
    async insertFeedback(row) {
      if (rows.has(row.id)) return { duplicate: true, received_at: new Date(rows.get(row.id).received_ms).toISOString() };
      rows.set(row.id, row);
      return { duplicate: false, received_at: new Date(row.received_ms).toISOString() };
    },
  };
}

async function startApp(t, { v = defaultView('dev'), store = fakeStore() } = {}) {
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, () => {});
  const clock = { ms: T0 };
  const remote = createRemoteConfig({ env: 'dev', url: null });
  remote._set(v);
  const app = createPublicApp(null, { v1: { env: { ENV: 'dev', SESSION_KEY: KEY }, remote, now: () => clock.ms, feedbackStore: store } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (body, { headers = HEADERS, token } = {}) => {
    const h = { ...headers, 'Content-Type': 'application/json' };
    if (token !== undefined) h.Authorization = token;
    const r = await fetch(`${base}/v1/feedback`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: JSON.parse(await r.text()) };
  };
  return { send, store, clock, remote, v };
}

const code = (r) => (r.body.result === 'error' ? r.body.error.code : r.body.result);
const session = (uid, nowSec = T0 / 1000, keyHex = KEY) => `Bearer ${signSession({ uid, env: 'dev', nowSec, keyHex }).token}`;

test('anonymous: ok {id, received_at}, and the row has no user, the install id only as a UUID', async (t) => {
  const { send, store } = await startApp(t);
  const id = uuid().toUpperCase();
  const r = await send({ id, message: '  the jump felt late  ', tags: ['bug'], written_at: '2026-10-14T17:59:58Z', context: { where: 'main_menu' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'ok', data: { id: id.toLowerCase(), received_at: '2026-10-14T18:00:00.000Z' } });
  const row = store.rows.get(id.toLowerCase());
  assert.equal(row.message, 'the jump felt late');
  assert.deepEqual([row.user_id, row.username, row.install_id], [null, null, INSTALL.toLowerCase()]);
  assert.deepEqual([row.build, row.platform, row.env, row.ip], [29612345, 'android', 'dev', '127.0.0.1']);
  assert.deepEqual(row.tags, ['bug']);
  assert.equal(row.written_at, '2026-10-14T17:59:58Z');

  const id2 = uuid();
  await send({ id: id2, message: 'x' }, { headers: { ...HEADERS, 'X-RJ-Install': 'not-a-uuid; DROP TABLE' } });
  assert.equal(store.rows.get(id2).install_id, null);
  const id3 = uuid();
  await send({ id: id3, message: 'x' }, { headers: { ...HEADERS, 'X-RJ-Build': '' } });
  assert.equal(store.rows.get(id3).build, null, 'no build header');
});

test('a valid bearer names the user from the session (never the body), with their username now', async (t) => {
  const { send, store } = await startApp(t);
  const id = uuid();
  const r = await send({ id, message: 'hi', user_id: 99, username: 'Spoof' }, { token: session(7) });
  assert.equal(code(r), 'ok');
  assert.deepEqual([store.rows.get(id).user_id, store.rows.get(id).username], [7, 'Pilot_Seven']);
  assert.equal(store.rows.get(id).install_id, INSTALL.toLowerCase());

  const gone = uuid();
  assert.equal(code(await send({ id: gone, message: 'hi' }, { token: session(8) })), 'ok');
  assert.deepEqual([store.rows.get(gone).user_id, store.rows.get(gone).username], [null, null], 'an account that is gone: anonymous');

  const notBearer = uuid();
  assert.equal(code(await send({ id: notBearer, message: 'hi' }, { token: 'Basic abc' })), 'ok');
  assert.equal(store.rows.get(notBearer).user_id, null);
});

test('a bad bearer answers AUTH_REQUIRED, an expired one AUTH_EXPIRED, and nothing is stored', async (t) => {
  const { send, store } = await startApp(t);
  assert.equal(code(await send({ id: uuid(), message: 'x' }, { token: 'Bearer garbage' })), 'AUTH_REQUIRED');
  assert.equal(code(await send({ id: uuid(), message: 'x' }, { token: session(7, T0 / 1000, OTHER_KEY) })), 'AUTH_REQUIRED');
  const grant = `Bearer ${sign({ v: 1, typ: 'g', ticket: 't', install: 'i', env: 'dev', iat: T0 / 1000, exp: T0 / 1000 + 60 }, KEY)}`;
  assert.equal(code(await send({ id: uuid(), message: 'x' }, { token: grant })), 'AUTH_REQUIRED', 'another token type');
  const expired = await send({ id: uuid(), message: 'x' }, { token: session(7, T0 / 1000 - 7200) });
  assert.equal(code(expired), 'AUTH_EXPIRED');
  assert.equal(expired.status, 401);
  assert.equal(store.rows.size, 0);
});

test('a repeat id answers ok with the first received_at and changes nothing', async (t) => {
  const { send, store, clock } = await startApp(t);
  const id = uuid();
  await send({ id, message: 'first' });
  clock.ms += 5000;
  const r = await send({ id, message: 'second' });
  assert.deepEqual(r.body.data, { id, received_at: '2026-10-14T18:00:00.000Z' });
  assert.equal(store.rows.get(id).message, 'first');
});

test('VALIDATION only for a malformed entry: the id, or the message', async (t) => {
  const { send, store } = await startApp(t);
  for (const body of [
    { message: 'no id' }, { id: 'abc', message: 'x' }, { id: 42, message: 'x' }, { id: `${uuid()}x`, message: 'x' },
    { id: uuid() }, { id: uuid(), message: '' }, { id: uuid(), message: ' \n\t ' }, { id: uuid(), message: 5 },
    { id: uuid(), message: ['x'] },
  ]) {
    const r = await send(body);
    assert.equal(code(r), 'VALIDATION', JSON.stringify(body));
    assert.equal(r.status, 400);
  }
  assert.equal(store.rows.size, 0);
});

test('everything else is repaired, never refused: length, tags, written_at, context', async (t) => {
  const { send, store } = await startApp(t);
  const id = uuid();
  const long = '🎮'.repeat(2500);
  const r = await send({
    id, message: long, tags: ['Bug', 'bug', 'IDEA', 'nope', 7, null, 'unfair'], written_at: 'x'.repeat(100),
    context: { where: 'pause_sp', blob: 'y'.repeat(5000), build: 12 },
  });
  assert.equal(code(r), 'ok');
  const row = store.rows.get(id);
  assert.equal([...row.message].length, 2000, '2000 code points, not UTF-16 units');
  assert.equal(row.message, '🎮'.repeat(2000));
  assert.deepEqual(row.tags, ['bug', 'idea', 'unfair']);
  assert.equal(row.written_at, 'x'.repeat(40));
  assert.deepEqual(row.context, { truncated: true, where: 'pause_sp', build: 12 });

  const id2 = uuid();
  await send({ id: id2, message: 'm', tags: 'bug', written_at: 12, context: [1, 2] });
  assert.deepEqual([store.rows.get(id2).tags, store.rows.get(id2).written_at, store.rows.get(id2).context], [[], null, {}]);
});

test('the per-minute and per-day limits per IP, from config', async (t) => {
  const v = defaultView('dev');
  v.server.rate_limits = { ...v.server.rate_limits, feedback_per_min_ip: 2, feedback_per_day_ip: 3 };
  const { send, clock } = await startApp(t, { v });
  assert.equal(code(await send({ id: uuid(), message: 'a' })), 'ok');
  assert.equal(code(await send({ id: uuid(), message: 'b' })), 'ok');
  const min = await send({ id: uuid(), message: 'c' });
  assert.equal(code(min), 'RATE_LIMITED');
  assert.equal(min.body.error.retry.kind, 'after');
  assert.equal(min.body.error.retry.after_ms, WINDOW_MS);
  assert.equal(min.headers.get('retry-after'), '60');

  clock.ms += WINDOW_MS;
  assert.equal(code(await send({ id: uuid(), message: 'd' })), 'ok', 'the third of the day');
  const day = await send({ id: uuid(), message: 'e' });
  assert.equal(code(day), 'RATE_LIMITED');
  assert.equal(day.body.error.retry.after_ms, DAY_MS - WINDOW_MS);
  clock.ms = T0 + DAY_MS;
  assert.equal(code(await send({ id: uuid(), message: 'f' })), 'ok', 'a new day');
});

test('gates 1-3 apply; the multiplayer floor and multiplayer maintenance do not; flags.feedback is not read', async (t) => {
  const v = defaultView('dev');
  const { send } = await startApp(t, { v });
  v.gates.min_build_multiplayer = { default: 99999999 };
  v.gates.maintenance = { active: true, scope: 'multiplayer', title: '', message: 'MP down', ends_at: null };
  v.flags.feedback = false;
  assert.equal(code(await send({ id: uuid(), message: 'x' })), 'ok');
  v.gates.maintenance.scope = 'app';
  assert.equal(code(await send({ id: uuid(), message: 'x' })), 'MAINTENANCE');
  v.gates.maintenance.active = false;
  v.gates.min_build = { default: 99999999 };
  const r = await send({ id: uuid(), message: 'x' });
  assert.deepEqual([code(r), r.body.error.scope], ['UPDATE_REQUIRED', 'app']);
  assert.equal(code(await send({ id: uuid(), message: 'x' }, { headers: { ...HEADERS, 'X-RJ-Env': 'alpha' } })), 'ENV_MISMATCH');
});

// --- feedback/entry.js, pure -------------------------------------------------------------------------------------

test('cutCodePoints counts code points, and leaves short strings alone', () => {
  assert.equal(cutCodePoints('a😀b', 2), 'a😀');
  assert.equal(cutCodePoints('abc', 5), 'abc');
  assert.equal(cleanEntry({ id: uuid(), message: ' é ' }).message, 'é');
});

test('capContext keeps a context under 4 KB whole, and fits top-level keys in order over it', () => {
  const small = { where: 'main_menu', device: { model: 'Pixel' } };
  assert.equal(capContext(small), small);
  const big = { a: 'x'.repeat(3000), b: 'y'.repeat(3000), c: 1, truncated: false };
  const out = capContext(big);
  assert.deepEqual(Object.keys(out), ['truncated', 'a', 'c']);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= CONTEXT_MAX_BYTES);
  assert.deepEqual(capContext({ huge: '€'.repeat(2000) }), { truncated: true }, 'bytes, not characters');
  assert.deepEqual(capContext('str'), {});
  assert.deepEqual(capContext(null), {});
});
