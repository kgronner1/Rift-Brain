'use strict';
// The admission queue (spec M6), pure over an injected clock and config: no HTTP, no database, no global fetch (so it
// also runs on the box's Node 16).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdmission, POLL_MIN_MS, POLL_MAX_MS, MESSAGE } = require('../src/admission/admission');
const { defaultView } = require('../src/config/remote');
const { verifyGrant, signGrant, sign, nowSecFrom } = require('../src/auth/tokens');

const KEY = 'ab'.repeat(32);
const ENV = { ENV: 'dev', SESSION_KEY: KEY };
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function setup(admission = {}, { random = Math.random } = {}) {
  const view = defaultView('dev');
  Object.assign(view.server.admission, { enabled: true, rate_per_min: 60, burst: 2 }, admission);
  const clock = { t: T0 };
  const lines = [];
  const logger = { info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) };
  const a = createAdmission({ env: ENV, config: () => view, now: () => clock.t, random, logger });
  const advance = (ms) => {
    clock.t += ms;
  };
  // Steps the clock a second at a time, sweeping each, as the 1 s timer does.
  const run = (sec) => {
    for (let i = 0; i < sec; i++) {
      advance(1000);
      a.sweep();
    }
  };
  return { a, view, clock, advance, run, lines };
}

const install = (n) => `install-${n}`;

function signIn(a, n, extra = {}) {
  return a.gate({ install: install(n), ...extra });
}

test('off (the default): everyone is admitted, and nothing is queued', () => {
  const view = defaultView('dev');
  assert.equal(view.server.admission.enabled, false);
  const a = createAdmission({ env: ENV, config: () => view, now: () => T0 });
  for (let i = 0; i < 500; i++) assert.equal(a.gate({ install: install(i) }).result, 'admitted');
  assert.equal(a.tickets.size, 0);
});

test('on: the burst is admitted, then sign-ins queue with the 4.2 shape', () => {
  const { a } = setup();
  assert.equal(signIn(a, 1).result, 'admitted');
  assert.equal(signIn(a, 2).result, 'admitted');
  const r = signIn(a, 3);
  assert.equal(r.result, 'queued');
  const q = r.queued;
  assert.deepEqual(Object.keys(q), ['ticket', 'kind', 'position', 'eta_sec', 'poll_after_ms', 'expires_in_sec', 'message']);
  assert.match(q.ticket, /^q_[A-Za-z0-9_-]{8,64}$/);
  assert.equal(q.kind, 'admission');
  assert.equal(q.position, 1);
  assert.equal(q.expires_in_sec, 600);
  assert.equal(q.message, MESSAGE);
  assert.ok(q.eta_sec >= 1 && q.eta_sec <= 2, `eta ${q.eta_sec}`);
});

test('anyone already waiting queues a newcomer even when a token is free (FIFO)', () => {
  const { a, advance } = setup({ burst: 1 });
  assert.equal(signIn(a, 1).result, 'admitted');
  assert.equal(signIn(a, 2).result, 'queued');
  advance(5000); // the bucket refills, the sweep has not run
  assert.equal(signIn(a, 3).result, 'queued');
});

test('one ticket per install: asking again keeps the same place', () => {
  const { a } = setup({ burst: 1 });
  signIn(a, 1);
  const first = signIn(a, 2).queued;
  const again = signIn(a, 2).queued;
  assert.equal(again.ticket, first.ticket);
  assert.equal(a.tickets.size, 1);
});

test('the sweep grants FIFO at the configured rate, and a granted poll answers {grant}', () => {
  const { a, run } = setup({ rate_per_min: 60, burst: 1 });
  signIn(a, 0);
  const tickets = [];
  for (let i = 1; i <= 10; i++) tickets.push(signIn(a, i).queued.ticket);
  const grantedAfter = [];
  for (let s = 1; s <= 12; s++) {
    run(1);
    const granted = tickets.filter((tk, i) => a.poll(tk, install(i + 1)).result === 'ok').length;
    grantedAfter.push(granted);
  }
  // 60 per minute = one a second; never more than the rate (plus the one that refilled during the first second).
  for (let s = 0; s < grantedAfter.length; s++) assert.ok(grantedAfter[s] <= s + 1, `after ${s + 1}s: ${grantedAfter[s]}`);
  assert.equal(grantedAfter[9], 10);
  // FIFO: whoever is granted, everyone ahead of them is too.
  const { a: b, run: runB } = setup({ rate_per_min: 60, burst: 1 });
  signIn(b, 0);
  const tk = [];
  for (let i = 1; i <= 5; i++) tk.push(signIn(b, i).queued.ticket);
  runB(3);
  const states = tk.map((t, i) => b.poll(t, install(i + 1)).result);
  assert.deepEqual(states, ['ok', 'ok', 'ok', 'queued', 'queued']);

  const r = b.poll(tk[0], install(1));
  assert.deepEqual(Object.keys(r.data), ['grant']);
  const g = verifyGrant(r.data.grant, { keyHex: KEY, env: 'dev', nowSec: nowSecFrom(T0 + 3000) });
  assert.equal(g.ok, true);
  assert.equal(g.payload.typ, 'g');
  assert.equal(g.payload.ticket, tk[0]);
  assert.equal(g.payload.install, install(1));
  assert.equal(g.payload.env, 'dev');
  assert.equal(g.payload.exp - g.payload.iat, 120);
});

test('a high rate is honoured too: 600 per minute grants ten a second', () => {
  const { a, run } = setup({ rate_per_min: 600, burst: 1 });
  signIn(a, 0);
  for (let i = 1; i <= 100; i++) signIn(a, i);
  run(1);
  assert.equal(a.waiting.length, 90);
  run(4);
  assert.equal(a.waiting.length, 50);
});

test('poll intervals vary per client, follow clamp(eta/10, 2 s, 30 s) x [0.8, 1.2]', () => {
  const { a } = setup({ rate_per_min: 1, burst: 1 });
  signIn(a, 0);
  const polls = [];
  for (let i = 1; i <= 40; i++) polls.push(signIn(a, i).queued);
  assert.ok(new Set(polls.map((q) => q.poll_after_ms)).size > 20, 'jittered per client');
  for (const q of polls) {
    const base = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, (q.eta_sec * 1000) / 10));
    assert.ok(q.poll_after_ms >= Math.floor(base * 0.8) && q.poll_after_ms <= Math.ceil(base * 1.2), JSON.stringify(q));
  }
  // The far end of a 1-per-minute line waits ~40 min: polls are capped at 30 s (x 1.2).
  assert.ok(polls[39].poll_after_ms <= 36000 && polls[39].poll_after_ms >= 24000);
  // The front of a fast line polls at the 2 s floor (x 0.8 .. 1.2).
  const { a: fast } = setup({ rate_per_min: 6000, burst: 1 });
  signIn(fast, 0);
  const q = signIn(fast, 1).queued;
  assert.ok(q.poll_after_ms >= 1600 && q.poll_after_ms <= 2400, String(q.poll_after_ms));
});

test('a refresh is exempt: admitted while the line is long, and it takes no token', () => {
  const { a } = setup({ burst: 1 });
  signIn(a, 0);
  for (let i = 1; i <= 5; i++) signIn(a, i);
  const before = a.tokens;
  assert.equal(a.gate({ install: install(99), refresh: true }).result, 'admitted');
  assert.equal(a.tokens, before);
  assert.equal(a.tickets.size, 5);
});

test('a grant is redeemed by its install only; a foreign or forged one is QUEUE_TICKET_INVALID', () => {
  const { a, run } = setup({ burst: 1 });
  signIn(a, 0);
  const tk = signIn(a, 1).queued.ticket;
  run(2);
  const grant = a.poll(tk, install(1)).data.grant;

  assert.deepEqual(a.gate({ install: install(2), grant }), { result: 'error', code: 'QUEUE_TICKET_INVALID' });
  assert.deepEqual(a.gate({ install: '', grant }), { result: 'error', code: 'QUEUE_TICKET_INVALID' });
  const forged = sign({ v: 1, typ: 'g', ticket: tk, install: install(1), env: 'dev', iat: 0, exp: 2e9 }, 'cd'.repeat(32));
  assert.equal(a.gate({ install: install(1), grant: forged }).code, 'QUEUE_TICKET_INVALID');
  const session = sign({ v: 1, typ: 's', uid: 1, env: 'dev', iat: 0, exp: 2e9 }, KEY);
  assert.equal(a.gate({ install: install(1), grant: session }).code, 'QUEUE_TICKET_INVALID', 'a session is not a grant');
  const alpha = signGrant({ ticket: tk, install: install(1), env: 'alpha', nowSec: nowSecFrom(T0), keyHex: KEY, ttlSec: 999 }).token;
  assert.equal(a.gate({ install: install(1), grant: alpha }).code, 'QUEUE_TICKET_INVALID', 'another env');
  assert.equal(a.gate({ install: install(1), grant: 42 }).code, 'QUEUE_TICKET_INVALID');

  assert.equal(a.gate({ install: install(1), grant }).result, 'admitted');
  assert.equal(a.tickets.has(tk), false, 'redeemed: the ticket is done');
  assert.equal(a.gate({ install: install(1), grant }).result, 'admitted', 'valid to its exp for that install (a mistyped password)');
});

test('a grant still verifies after a restart lost the ticket (it is signed)', () => {
  const { a, clock } = setup({ burst: 1 });
  signIn(a, 0);
  const grant = signGrant({ ticket: 'q_lostlostlost', install: install(1), env: 'dev', nowSec: nowSecFrom(clock.t), keyHex: KEY, ttlSec: 120 }).token;
  assert.equal(a.gate({ install: install(1), grant }).result, 'admitted');
});

test('polling an expired, unknown or foreign ticket answers QUEUE_TICKET_INVALID (or null for the lobby queue to try)', () => {
  const { a } = setup({ burst: 1, ticket_ttl_sec: 600 });
  signIn(a, 0);
  const tk = signIn(a, 1).queued.ticket;
  assert.deepEqual(a.poll(tk, install(2)), { result: 'error', code: 'QUEUE_TICKET_INVALID' });
  assert.deepEqual(a.leave(tk, install(2)), { result: 'error', code: 'QUEUE_TICKET_INVALID' });
  assert.equal(a.poll('q_neverissuedatall', install(1)), null);
  // A slow line, so the ticket is still waiting when it expires.
  const { a: slow, run: runSlow } = setup({ rate_per_min: 1, burst: 1, ticket_ttl_sec: 600 });
  signIn(slow, 0);
  const keep = [];
  for (let i = 1; i <= 30; i++) keep.push(signIn(slow, i).queued.ticket);
  runSlow(601);
  assert.equal(slow.poll(keep[29], install(30)), null, 'unpolled for ticket_ttl_sec: gone');
});

test('a ticket survives 9 minutes unpolled, and each poll extends it', () => {
  const { a, run } = setup({ rate_per_min: 1, burst: 1 });
  signIn(a, 0);
  const tks = [];
  for (let i = 1; i <= 30; i++) tks.push(signIn(a, i).queued.ticket);
  run(9 * 60);
  const r = a.poll(tks[29], install(30));
  assert.equal(r.result, 'queued');
  assert.equal(r.queued.expires_in_sec, 600);
  run(9 * 60);
  // Everyone ahead of it stopped polling and was dropped at 10 min, so by now it may hold a grant; it is not gone.
  const later = a.poll(tks[29], install(30));
  assert.ok(later && later.result !== 'error', 'the poll at 9 min renewed it');
  assert.equal(a.poll(tks[0], install(1)), null, 'the ones nobody polled are gone');
});

test('positions and eta never rise for a ticket, even when a lapsed grant re-queues at the front', () => {
  // One token per 20 s and a 10 s grant: ticket 1's grant lapses with no token free, so it re-queues ahead of
  // everyone, and the raw position of everyone behind it goes up by one.
  const { a, run } = setup({ rate_per_min: 3, burst: 1, grant_ttl_sec: 10 });
  signIn(a, 0);
  const tks = [];
  for (let i = 1; i <= 8; i++) tks.push(signIn(a, i).queued.ticket);
  const last = { position: Infinity, eta: Infinity };
  let lapsedSeen = false;
  for (let s = 0; s < 200; s++) {
    run(1);
    if (a.waiting[0] && a.waiting[0].id === tks[0]) lapsedSeen = true;
    const r = a.poll(tks[7], install(8));
    if (r.result !== 'queued') break;
    assert.ok(r.queued.position <= last.position, `position ${r.queued.position} after ${last.position}`);
    assert.ok(r.queued.eta_sec <= last.eta, `eta ${r.queued.eta_sec} after ${last.eta}`);
    last.position = r.queued.position;
    last.eta = r.queued.eta_sec;
  }
  assert.ok(lapsedSeen, 'the lapse happened (the measurement saw the case it guards)');
  assert.ok(last.position < 8, 'and the line moved');
});

test('an unredeemed grant lapses and its ticket re-queues at the front', () => {
  const { a, run } = setup({ rate_per_min: 3, burst: 1, grant_ttl_sec: 10 });
  signIn(a, 0);
  const t1 = signIn(a, 1).queued.ticket;
  const t2 = signIn(a, 2).queued.ticket;
  run(21); // one token per 20 s: ticket 1 granted
  assert.equal(a.poll(t1, install(1)).result, 'ok');
  assert.equal(a.waiting[0].id, t2);
  run(10); // its 10 s grant lapses before the next token
  assert.equal(a.waiting[0].id, t1, 'back at the front');
  assert.equal(a.waiting[1].id, t2);
  const lapsed = signIn(a, 1);
  assert.equal(lapsed.result, 'queued');
  assert.equal(lapsed.queued.ticket, t1);
});

test('an expired grant sent with a sign-in re-queues its ticket rather than starting a new one', () => {
  const { a, run, advance } = setup({ rate_per_min: 6, burst: 1, grant_ttl_sec: 10, ticket_ttl_sec: 600 });
  signIn(a, 0);
  const t1 = signIn(a, 1).queued.ticket;
  run(11);
  const grant = a.poll(t1, install(1)).data.grant;
  advance(11000);
  const r = a.gate({ install: install(1), grant });
  assert.equal(r.result, 'queued');
  assert.equal(r.queued.ticket, t1);
  assert.equal(r.queued.position, 1);
});

test('turning admission off releases everyone: polls grant, sign-ins pass, and the switch is live', () => {
  const { a, view, run, lines } = setup({ rate_per_min: 1, burst: 1 });
  signIn(a, 0);
  const tks = [];
  for (let i = 1; i <= 20; i++) tks.push(signIn(a, i).queued.ticket);
  view.server.admission.enabled = false; // a publish, read live: no restart
  assert.equal(signIn(a, 99).result, 'admitted');
  assert.equal(a.poll(tks[19], install(20)).result, 'ok', 'granted on its next poll');
  run(1);
  assert.equal(a.waiting.length, 0, 'and the sweep grants the rest');
  for (let i = 0; i < 20; i++) {
    const g = a.poll(tks[i], install(i + 1));
    assert.equal(g.result, 'ok');
    assert.equal(a.gate({ install: install(i + 1), grant: g.data.grant }).result, 'admitted');
  }
  assert.ok(lines.some((l) => /\[admission\] off/.test(l)));
  view.server.admission.enabled = true;
  assert.equal(signIn(a, 200).result, 'admitted', 'back on: the bucket refilled meanwhile');
  assert.ok(lines.some((l) => /\[admission\] on/.test(l)));
  assert.ok(lines.every((l) => !/eyJ/.test(l)), 'no token in a log line');
});

test('leaving the line (DELETE) frees the place', () => {
  const { a } = setup({ burst: 1 });
  signIn(a, 0);
  const t1 = signIn(a, 1).queued.ticket;
  const t2 = signIn(a, 2).queued.ticket;
  assert.deepEqual(a.leave(t1, install(1)), { result: 'ok', data: {} });
  assert.equal(a.poll(t1, install(1)), null);
  assert.equal(a.poll(t2, install(2)).queued.position, 1);
});

test('a sign-in with no install header cannot hold a ticket: VALIDATION, not an unpollable ticket', () => {
  const { a } = setup({ burst: 1 });
  signIn(a, 0);
  const r = a.gate({ install: '' });
  assert.equal(r.result, 'error');
  assert.equal(r.code, 'VALIDATION');
  assert.equal(a.tickets.size, 0);
});
