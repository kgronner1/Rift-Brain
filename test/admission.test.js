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
  // As run, with the given clients alive: each polls its ticket every second (live: [[ticket, n], ...]).
  const runLive = (sec, live) => {
    for (let i = 0; i < sec; i++) {
      advance(1000);
      a.sweep();
      for (const [tk, n] of live) a.poll(tk, `install-${n}`);
    }
  };
  return { a, view, clock, advance, run, runLive, lines };
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
  assert.equal(a.waiting.length, 0, 'redeemed: out of the line');
  assert.equal(a.gate({ install: install(1), grant }).result, 'admitted', 'valid to its exp for that install (a mistyped password)');
});

test('a granted ticket polled again answers the same {grant} until it is redeemed, and after, until the grant exp', () => {
  // The client (Net.queue) re-polls a granted ticket every queue_poll_default_ms until a session is issued, so a
  // redemption the database then refuses (a mistyped password) or whose answer is lost must not cost the grant.
  const { a, run, runLive, advance } = setup({ rate_per_min: 3, burst: 1, grant_ttl_sec: 30 });
  signIn(a, 0);
  const tk = signIn(a, 1).queued.ticket;
  const tk2 = signIn(a, 2).queued.ticket;
  runLive(21, [[tk, 1]]);
  const grant = a.poll(tk, install(1)).data.grant;
  for (let s = 0; s < 4; s++) {
    advance(5000);
    assert.deepEqual(a.poll(tk, install(1)), { result: 'ok', data: { grant } }, `re-poll ${s + 1}`);
  }
  assert.equal(a.gate({ install: install(1), grant }).result, 'admitted');
  advance(5000);
  assert.deepEqual(a.poll(tk, install(1)), { result: 'ok', data: { grant } }, 'redeemed: polls still answer the grant');
  assert.equal(a.gate({ install: install(1), grant }).result, 'admitted', 'and it still redeems (the retyped password)');
  run(10); // past the grant's exp
  assert.equal(a.poll(tk, install(1)), null, 'a redeemed ticket is dropped at its grant exp (the route: QUEUE_TICKET_INVALID)');
  assert.equal(a.tickets.has(tk), false);
  assert.ok(!a.waiting.some((w) => w.id === tk));
  a.poll(tk2, install(2)); // someone is waiting, alive
  assert.equal(signIn(a, 1).result, 'queued', 'a later sign-in with no grant takes a new place');
  assert.notEqual(signIn(a, 1).queued.ticket, tk);
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
  // Everyone is alive (polls every second); ticket 1 collects its grant and never redeems it.
  const { a, runLive } = setup({ rate_per_min: 3, burst: 1, grant_ttl_sec: 10 });
  signIn(a, 0);
  const tks = [];
  for (let i = 1; i <= 8; i++) tks.push(signIn(a, i).queued.ticket);
  const live = tks.slice(0, 7).map((tk, i) => [tk, i + 1]);
  const last = { position: Infinity, eta: Infinity };
  let lapsedSeen = false;
  let granted1 = false;
  for (let s = 0; s < 200; s++) {
    runLive(1, live);
    if (a.tickets.get(tks[0]) && a.tickets.get(tks[0]).grant) granted1 = true;
    if (granted1 && a.waiting[0] && a.waiting[0].id === tks[0]) lapsedSeen = true;
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
  const { a, run, runLive } = setup({ rate_per_min: 3, burst: 1, grant_ttl_sec: 10 });
  signIn(a, 0);
  const t1 = signIn(a, 1).queued.ticket;
  const t2 = signIn(a, 2).queued.ticket;
  runLive(21, [[t1, 1], [t2, 2]]); // one token per 20 s: ticket 1 granted (and collected)
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

// RJ 481: abandoned tickets. A client as Net.queue runs it: polls when poll_after_ms says, redeems a grant at once,
// and pauses (backgrounded) or stops (killed) on cue. step() advances one second and sweeps, as the 1 s timer does.
function line(admission) {
  const s = setup({ rate_per_min: 1, burst: 1, grant_ttl_sec: 120, ticket_ttl_sec: 600, ...admission });
  const clients = new Map(); // n -> {ticket, nextPollAt, alive, grantedAt, admittedAt, redeem}
  const join = (n, { alive = true, redeem = true } = {}) => {
    const r = signIn(s.a, n);
    assert.equal(r.result, 'queued');
    const c = { n, ticket: r.queued.ticket, nextPollAt: s.clock.t + r.queued.poll_after_ms, alive, grantedAt: null, admittedAt: null, redeem };
    clients.set(n, c);
    return c;
  };
  const pollNow = (c) => {
    const r = s.a.poll(c.ticket, install(c.n));
    if (r && r.result === 'ok') {
      if (c.grantedAt === null) c.grantedAt = s.clock.t;
      if (c.redeem && s.a.gate({ install: install(c.n), grant: r.data.grant }).result === 'admitted') {
        c.admittedAt = s.clock.t;
        c.alive = false; // signed in: done with the line
      }
      c.nextPollAt = s.clock.t + 5000; // queue_poll_default_ms
    } else if (r && r.result === 'queued') {
      c.nextPollAt = s.clock.t + r.queued.poll_after_ms;
    }
    return r;
  };
  const step = (sec = 1) => {
    for (let i = 0; i < sec; i++) {
      s.advance(1000);
      s.a.sweep();
      for (const c of clients.values()) if (c.alive && s.clock.t >= c.nextPollAt) pollNow(c);
    }
  };
  signIn(s.a, 0); // spends the burst: everyone after this queues
  return { ...s, clients, join, step, pollNow };
}

test('RJ 481: dead tickets ahead no longer stall the line (one rate interval per live ticket ahead)', () => {
  const L = line();
  const dead = [];
  for (let i = 1; i <= 6; i++) dead.push(L.join(i, { alive: false })); // killed while queued: never poll again
  const l1 = L.join(7);
  const l2 = L.join(8);
  L.step(55);
  // Positions count live tickets only: once the dead have missed a poll (their last poll_after_ms + IDLE_GRACE_MS),
  // L2 is told #2, not #8.
  assert.equal(L.a.poll(l2.ticket, install(8)).queued.position, 2, 'the dead do not count');
  L.step(145);
  // 1/min: L1 at the first token (60 s), L2 at the next; a poll can trail its grant by a few seconds.
  assert.ok(l1.admittedAt !== null && l1.admittedAt - T0 <= 60000 + 10000, `L1 admitted at ${(l1.admittedAt - T0) / 1000}s`);
  assert.ok(l2.admittedAt !== null && l2.admittedAt - T0 <= 120000 + 10000, `L2 admitted at ${(l2.admittedAt - T0) / 1000}s`);
  for (const d of dead) assert.equal(L.a.tickets.get(d.ticket).grant, null, 'no admission was spent on a dead ticket');
  // With nobody live waiting, a newcomer is admitted on a free token rather than queued behind the dead.
  assert.equal(signIn(L.a, 9).result, 'admitted');
  // Before the fix: each dead ticket held the head for ticket_ttl_sec. Measure the old rule's positive case: with every
  // ticket alive, the same line admits L1 only after the six ahead of it.
  const M = line();
  for (let i = 1; i <= 6; i++) M.join(i);
  const m7 = M.join(7);
  M.step(480);
  assert.ok(m7.admittedAt !== null && m7.admittedAt - T0 >= 6 * 60000, `with six live ahead, #7 admitted at ${(m7.admittedAt - T0) / 1000}s`);
});

test('RJ 481: a client that dies holding an uncollected grant costs one interval once, and its token comes back', () => {
  const L = line();
  const d = L.join(1, { redeem: false });
  const l = L.join(2);
  L.step(50);
  d.alive = false; // killed after its last poll, just before its grant
  L.step(15);
  assert.ok(L.a.tickets.get(d.ticket).grant, 'granted while it still looked alive');
  assert.equal(L.a.tickets.get(d.ticket).collected, false);
  L.step(60); // L takes the next token: the dead grant cost it one interval
  assert.ok(l.admittedAt !== null && l.admittedAt - T0 <= 125000, `L admitted at ${l.admittedAt && (l.admittedAt - T0) / 1000}s`);
  L.view.server.admission.burst = 5; // room in the bucket, so the hand-back is visible past the cap
  const before = L.a.tokens;
  L.step(60); // the grant (issued at 60 s) lapses at 180 s
  assert.equal(L.a.tickets.get(d.ticket).grant, null, 'lapsed');
  assert.ok(L.a.tokens - before >= 1.9, `its token came back with the minute's own (${before} -> ${L.a.tokens})`);
  assert.equal(L.a.waiting[0].id, d.ticket, 'the dead one went back to the front, where it is passed over');
  assert.equal(signIn(L.a, 3).result, 'admitted', 'and a newcomer is admitted on the tokens it left');
  L.step(600);
  assert.equal(L.a.tickets.has(d.ticket), false, 'and is dropped at ticket_ttl_sec');
});

test('RJ 481: a ticket backgrounded 5 minutes keeps its place among everyone still waiting', () => {
  // Only the tickets behind it that were admitted while it was away (on the tokens it was not there to collect) pass it.
  const L = line();
  const ahead = L.join(1);
  const b = L.join(2);
  const behind = [];
  for (let i = 3; i <= 12; i++) behind.push(L.join(i));
  L.step(30);
  b.alive = false; // backgrounded: the client pauses polling
  L.step(300);
  assert.ok(ahead.admittedAt !== null);
  assert.equal(L.a.tickets.get(b.ticket).grant, null, 'not granted while away');
  const passed = behind.filter((c) => c.admittedAt !== null).length;
  assert.ok(passed >= 3 && passed <= 5, `${passed} behind it admitted while it was away`);
  const stillWaiting = behind.filter((c) => c.admittedAt === null);
  b.alive = true; // foregrounded: polls at once
  const resumedAt = L.clock.t;
  const r = L.pollNow(b);
  assert.equal(r.result, 'queued');
  assert.equal(r.queued.ticket, b.ticket, 'the same ticket');
  assert.equal(r.queued.position, 1, 'first among those still waiting');
  L.step(90);
  assert.ok(b.admittedAt !== null && b.admittedAt - resumedAt <= 60000 + 5000, 'admitted at the next token');
  for (const c of stillWaiting) assert.ok(c.admittedAt === null || c.admittedAt > b.admittedAt, `#${c.n} not ahead of it`);
});

test('RJ 481: kill + relaunch resumes the saved ticket at its place (unchanged)', () => {
  const L = line();
  const ahead = L.join(1);
  const k = L.join(2);
  const after = L.join(3);
  L.step(10);
  k.alive = false; // killed
  L.step(40);
  // Relaunched 40 s later: the client polls its saved ticket, and a sign-in from the same install finds it too.
  const resumed = L.pollNow(k);
  assert.equal(resumed.result, 'queued');
  assert.equal(resumed.queued.ticket, k.ticket);
  const again = signIn(L.a, 2);
  assert.equal(again.queued.ticket, k.ticket, 'one ticket per install');
  k.alive = true;
  L.step(200);
  assert.ok(ahead.admittedAt < k.admittedAt && k.admittedAt < after.admittedAt, 'FIFO held');
});

test('RJ 481: a mistyped password keeps the grant (the client re-polls it, so it stays collected and live)', () => {
  const L = line();
  const p = L.join(1, { redeem: false });
  const q = L.join(2);
  L.step(70);
  const g = L.a.poll(p.ticket, install(1));
  assert.equal(g.result, 'ok');
  // The sign-in with the grant is admitted; the database then refuses the password. Retyping takes 100 s, polling
  // every 5 s as the client does with a granted ticket.
  assert.equal(L.a.gate({ install: install(1), grant: g.data.grant }).result, 'admitted');
  L.step(100);
  assert.deepEqual(L.a.poll(p.ticket, install(1)), { result: 'ok', data: { grant: g.data.grant } });
  assert.equal(L.a.gate({ install: install(1), grant: g.data.grant }).result, 'admitted', 'the retyped password');
  assert.equal(q.admittedAt !== null, true, 'and the line kept moving behind it');
});
