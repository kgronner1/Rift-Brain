'use strict';
// The feedback forwarder (RJ 489) against a fake Apps Script endpoint over real HTTP and Node's own fetch: the web app's
// 302 to a GET, a batch, a partial confirm, an HTML answer, a timeout, the backoff, the daily cap, the in-flight
// guard, and an account anonymised while its batch is out. The store is an in-memory stand-in with the SQL's rules;
// feedback.db.test.js runs the forwarder over the real table.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createFeedbackForwarder, backoffSec } = require('../src/feedback/forwarder');
const { sheetRow, deviceText, runText } = require('../src/feedback/sheetRow');
const { defaultView } = require('../src/config/remote');

const T0 = Date.UTC(2026, 9, 14, 18, 0, 0);
const SECRET = 'ab'.repeat(32);
const DAY = 24 * 3600 * 1000;

function memoryStore() {
  const rows = new Map();
  const due = (state, limit, t) => [...rows.values()]
    .filter((r) => r.sheet_state === state && (r.sheet_next_at === null || r.sheet_next_at <= t))
    .sort((a, b) => a.received_ms - b.received_ms || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((r) => ({ ...r, received_at: new Date(r.received_ms).toISOString() }));
  return {
    rows,
    add(n, { t = T0, user = null } = {}) {
      const ids = [];
      for (let i = 0; i < n; i++) {
        const id = `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, '0')}`;
        rows.set(id, { id, received_ms: t - 100000 + rows.size, written_at: '2026-10-14T17:00:00Z', user_id: user && user.id,
          username: user && user.name, build: 7, platform: 'android', env: 'dev', tags: 'bug', message: `note ${id.slice(-3)}`,
          context: '{"where":"main_menu"}', sheet_state: 'pending', sheet_attempts: 0, sheet_next_at: null,
          sheet_sent_at: null, anonymized_at: null });
        ids.push(id);
      }
      return ids;
    },
    anonymize(uid, t) {
      for (const r of rows.values()) {
        if (r.user_id !== uid) continue;
        if (r.sheet_state === 'sent') Object.assign(r, { sheet_state: 'anon_pending', sheet_attempts: 0, sheet_next_at: null });
        Object.assign(r, { user_id: null, username: null, anonymized_at: new Date(t).toISOString() });
      }
    },
    async dueForAppend(limit, t) { return due('pending', limit, t); },
    async dueForAnonymize(limit, t) { return due('anon_pending', limit, t); },
    async sentSince(t) { return [...rows.values()].filter((r) => r.sheet_sent_at !== null && r.sheet_sent_at >= t).length; },
    async markSent(ids, t) {
      for (const id of ids) {
        const r = rows.get(id);
        if (r.sheet_state !== 'pending') continue;
        Object.assign(r, { sheet_state: r.anonymized_at === null ? 'sent' : 'anon_pending', sheet_sent_at: t, sheet_attempts: 0, sheet_next_at: null });
      }
    },
    async markAnonDone(ids) {
      for (const id of ids) {
        const r = rows.get(id);
        if (r.sheet_state === 'anon_pending') Object.assign(r, { sheet_state: 'done_anon', sheet_attempts: 0, sheet_next_at: null });
      }
    },
    async backoff(ids, state, t, b) {
      for (const id of ids) {
        const r = rows.get(id);
        if (r.sheet_state !== state) continue;
        r.sheet_next_at = t + backoffSec(r.sheet_attempts, b) * 1000;
        r.sheet_attempts += 1;
      }
    },
  };
}

// A stand-in for the Apps Script web app: POST /exec runs `handler` and answers 302 to a GET that returns its output,
// as Google does. handler(body) -> {status?, json?, text?, hang?}.
async function fakeScript(t, handler) {
  const posts = [];
  const outputs = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/echo/')) {
      const out = outputs.get(req.url.slice(6));
      res.writeHead(out.status || 200, { 'Content-Type': out.text !== undefined ? 'text/html' : 'application/json' });
      res.end(out.text !== undefined ? out.text : JSON.stringify(out.json));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      posts.push(body);
      const out = await handler(body, posts.length);
      if (out.hang) return; // never answers
      if (out.status && out.status !== 200) {
        res.writeHead(out.status, { 'Content-Type': 'text/html' });
        res.end(out.text || '<html>error</html>');
        return;
      }
      const key = String(++n);
      outputs.set(key, out);
      res.writeHead(302, { Location: `/echo/${key}` });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/exec`, posts };
}

// The script's own rule: it holds every id it is sent.
const holdAll = (body) => ({ json: { ok: true, ids: body.rows.map((r) => r['Feedback ID']) } });

function forwarder(store, url, { clock = { ms: T0 }, view = defaultView('dev'), timeoutMs = 2000 } = {}) {
  const lines = [];
  const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (...a) => lines.push(a.join(' ')) };
  const f = createFeedbackForwarder({ url, secret: SECRET, config: () => view, store, now: () => clock.ms, logger, timeoutMs });
  return { f, lines, clock, view };
}

test('a batch of 20, oldest first, through the 302; the request carries the secret, the op and header-keyed rows', async (t) => {
  const store = memoryStore();
  const ids = store.add(25);
  const s = await fakeScript(t, holdAll);
  const { f } = forwarder(store, s.url);
  const r = await f.tick();
  assert.deepEqual(r.append, { sent: 20, confirmed: 20 });
  assert.equal(s.posts.length, 1, 'no anonymize call when nothing waits');
  const body = s.posts[0];
  assert.deepEqual([body.secret, body.op], [SECRET, 'append']);
  assert.deepEqual(body.rows.map((x) => x['Feedback ID']), ids.slice(0, 20));
  assert.equal(body.rows[0].Player, 'anonymous');
  assert.ok(!('ip' in body.rows[0]) && !('Triage' in body.rows[0]) && !('Notes' in body.rows[0]));
  for (const id of ids.slice(0, 20)) assert.equal(store.rows.get(id).sheet_state, 'sent');
  assert.equal(store.rows.get(ids[20]).sheet_state, 'pending');
  await f.tick();
  assert.deepEqual(s.posts[1].rows.map((x) => x['Feedback ID']), ids.slice(20));
});

test('a partial confirm marks what the sheet holds and backs off the rest', async (t) => {
  const store = memoryStore();
  const ids = store.add(3);
  const s = await fakeScript(t, () => ({ json: { ok: true, ids: [ids[0], ids[2], 'someone-else'] } }));
  const { f, lines } = forwarder(store, s.url);
  assert.deepEqual((await f.tick()).append, { sent: 3, confirmed: 2 });
  assert.deepEqual(ids.map((id) => store.rows.get(id).sheet_state), ['sent', 'pending', 'sent']);
  assert.equal(store.rows.get(ids[1]).sheet_next_at, T0 + 30000);
  assert.ok(lines.some((l) => /confirmed 2 of 3/.test(l)), lines.join('\n'));
});

test('failures back off and log one line: HTML, non-2xx, ok:false, a timeout', async (t) => {
  const answers = [
    { text: '<!DOCTYPE html><html>Google error</html>' },
    { status: 500 },
    { json: { ok: false, error: 'bad secret' } },
    { json: { ok: true } },
    { hang: true },
  ];
  const store = memoryStore();
  const [id] = store.add(1);
  const s = await fakeScript(t, (body, n) => answers[n - 1]);
  const { f, lines, clock } = forwarder(store, s.url, { timeoutMs: 300 });
  const expect = [/an HTML page/, /HTTP 500/, /refused: bad secret/, /refused: ok is not true/, /no answer in 300 ms/];
  for (const [i, re] of expect.entries()) {
    const before = lines.length;
    const r = await f.tick();
    assert.deepEqual(r.append, { sent: 1, confirmed: 0 }, `answer ${i}`);
    assert.equal(lines.length, before + 1, 'one line per failed batch');
    assert.match(lines[lines.length - 1], re);
    assert.ok(!lines[lines.length - 1].includes(SECRET), 'never logs the secret');
    const row = store.rows.get(id);
    assert.equal(row.sheet_attempts, i + 1);
    assert.equal(row.sheet_next_at, clock.ms + backoffSec(i) * 1000);
    assert.deepEqual((await f.tick()).append, { sent: 0, confirmed: 0 }, 'not due yet: nothing sent');
    clock.ms = row.sheet_next_at;
  }
  assert.equal(s.posts.length, 5);
  assert.equal(store.rows.get(id).sheet_state, 'pending', 'kept, never lost');
});

test('the backoff doubles from 30 s and stops at an hour', () => {
  assert.deepEqual([0, 1, 2, 6, 7, 30].map((a) => backoffSec(a)), [30, 60, 120, 1920, 3600, 3600]);
});

test('the daily cap: rows over it wait for the next UTC day; 0 sends nothing', async (t) => {
  const store = memoryStore();
  store.add(30);
  const s = await fakeScript(t, holdAll);
  const view = defaultView('dev');
  view.server.feedback_sheet_per_day = 25;
  const { f, lines, clock } = forwarder(store, s.url, { view });
  assert.equal((await f.tick()).append.sent, 20);
  assert.equal((await f.tick()).append.sent, 5, 'only the room left today');
  assert.equal((await f.tick()).append.sent, 0);
  await f.tick();
  assert.equal(lines.filter((l) => /daily cap \(25\)/.test(l)).length, 1, 'logged once a day');
  clock.ms = Math.floor(T0 / DAY) * DAY + DAY;
  assert.equal((await f.tick()).append.sent, 5, 'a new UTC day');
  view.server.feedback_sheet_per_day = 0;
  store.add(1, { t: clock.ms });
  assert.equal((await f.tick()).append.sent, 0);
});

test('an account anonymised while its batch is out: anon_pending, then the anonymize op, then done_anon', async (t) => {
  const store = memoryStore();
  const user = { id: 7, name: 'Pilot' };
  const [mine] = store.add(1, { user });
  const [theirs] = store.add(1, { user: { id: 8, name: 'Other' } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const statesAtAnonymize = [];
  const s = await fakeScript(t, async (body) => {
    if (body.op === 'append') await gate;
    else statesAtAnonymize.push(store.rows.get(mine).sheet_state);
    return holdAll(body);
  });
  const { f } = forwarder(store, s.url);
  const first = f.tick();
  while (s.posts.length === 0) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.posts[0].rows[0].Player, 'Pilot (#7)');
  assert.deepEqual(await f.tick(), { skipped: true }, 'the in-flight guard');
  store.anonymize(7, T0);
  release();
  await first;
  assert.deepEqual(statesAtAnonymize, ['anon_pending'], 'confirmed as anon_pending, not sent');
  assert.equal(store.rows.get(theirs).sheet_state, 'sent');
  // The same tick ran the anonymize pass after the append.
  assert.equal(s.posts.length, 2);
  assert.deepEqual([s.posts[1].op, s.posts[1].rows], ['anonymize', [{ 'Feedback ID': mine }]]);
  assert.equal(store.rows.get(mine).sheet_state, 'done_anon');
});

test('a failed anonymize backs off in its own state', async (t) => {
  const store = memoryStore();
  const [id] = store.add(1, { user: { id: 7, name: 'P' } });
  store.rows.get(id).sheet_state = 'sent';
  store.anonymize(7, T0);
  const s = await fakeScript(t, () => ({ status: 503 }));
  const { f } = forwarder(store, s.url);
  assert.deepEqual((await f.tick()).anonymize, { sent: 1, confirmed: 0 });
  assert.deepEqual([store.rows.get(id).sheet_state, store.rows.get(id).sheet_attempts], ['anon_pending', 1]);
});

test('a store error is logged and the next tick runs', async (t) => {
  const store = memoryStore();
  store.add(1);
  const s = await fakeScript(t, holdAll);
  const { f, lines } = forwarder(store, s.url);
  const orig = store.sentSince;
  store.sentSince = async () => { throw new Error('db down'); };
  await f.tick();
  assert.ok(lines.some((l) => /tick failed/.test(l) && /db down/.test(l)));
  store.sentSince = orig;
  assert.equal((await f.tick()).append.confirmed, 1);
});

test('sheetRow: Player, Device, Run / match, Tags and Context as the sheet shows them', () => {
  const base = { id: 'i', received_at: '2026-10-14T18:00:00.000Z', written_at: null, user_id: null, username: null,
    build: null, platform: null, env: 'alpha', tags: 'bug,unfair', message: '=1+1', anonymized_at: null };
  const ctx = { where: 'pause_sp', device: { model: 'Pixel 8', os: 'Android', os_version: '14', screen: [1080, 2400], locale: 'en' },
    run: { mission: 'TimeTrial', node: 'n3', level: 4, seed: 4242, run_sec: 81.24 } };
  const r = sheetRow({ ...base, context: JSON.stringify(ctx) });
  assert.deepEqual(r, {
    Received: '2026-10-14T18:00:00.000Z', Written: '', Env: 'alpha', Tags: 'bug, unfair', Feedback: '=1+1', Player: 'anonymous',
    Where: 'pause_sp', Build: '', Platform: '', Device: 'Pixel 8 · Android 14 · 1080x2400 · en',
    'Run / match': 'TimeTrial n3 · level 4 · seed 4242 · 81.2 s', 'Feedback ID': 'i', Context: JSON.stringify(ctx),
  });
  assert.equal(sheetRow({ ...base, user_id: 3, username: 'Ace', context: '{}' }).Player, 'Ace (#3)');
  assert.equal(sheetRow({ ...base, anonymized_at: '2026-10-15T00:00:00.000Z', context: '{}' }).Player, 'deleted account');
  assert.equal(runText({ match: { lobby: 'ABCD', players: 3, phase: 'pregame' } }), 'lobby ABCD · 3 players · pregame');
  assert.equal(deviceText({ model: { nested: 1 }, os: 'iOS' }), 'iOS');
  assert.equal(sheetRow({ ...base, context: 'not json' }).Where, '');
});
