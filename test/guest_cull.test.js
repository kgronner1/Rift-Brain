'use strict';
// RJ 493's guest cull over a stand-in store and registry: who it deletes and passes by, its log line, its batch, a
// failure, overlapping sweeps, and its timers (the first run, then the period). guests.db.test.js runs it against a
// real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuestCull, FIRST_MS, EVERY_MS, BATCH } = require('../src/guests/cull');
const { quietLogger } = require('./match_fixture');

function fakeStore(idle) {
  const calls = [];
  return {
    calls,
    idle,
    async findIdleGuests(q) { calls.push(['find', q]); return this.idle; },
    async deleteUser(uid, opts) { calls.push(['delete', uid, opts]); return uid !== 4; },
  };
}

function cull({ idle = [1, 2, 3, 4], held = [2], days = 7, ...opts } = {}) {
  const store = fakeStore(idle);
  const logger = quietLogger();
  const view = { server: { guest_cull_days: days } };
  const match = { holds: (uid) => held.includes(uid) };
  const c = createGuestCull({ config: () => view, match, store, logger, ...opts });
  return { c, store, logger, view };
}

test('a sweep deletes the idle guests the registry does not hold, with the idle guard, and logs one line', async () => {
  const { c, store, logger } = cull();
  assert.deepEqual(await c.sweep(), { culled: 2, held: 1 });
  assert.deepEqual(store.calls, [
    ['find', { days: 7, limit: BATCH }],
    ['delete', 1, { idleGuestDays: 7 }],
    ['delete', 3, { idleGuestDays: 7 }],
    ['delete', 4, { idleGuestDays: 7 }],
  ]);
  assert.deepEqual(logger.lines, ['[guests] culled 2 idle guest(s)'], '4 was no longer an idle guest under the lock');
});

test('guest_cull_days is read at every sweep; nothing culled logs nothing', async () => {
  const { c, store, logger, view } = cull({ idle: [] });
  view.server.guest_cull_days = 30;
  assert.deepEqual(await c.sweep(), { culled: 0, held: 0 });
  assert.deepEqual(store.calls, [['find', { days: 30, limit: BATCH }]]);
  assert.deepEqual(logger.lines, []);
  assert.equal(BATCH, 500);
});

test('without a registry nobody is held; a failure is logged and the next sweep runs', async () => {
  const { c, store, logger } = cull({ match: null, batch: 2 });
  assert.deepEqual(await c.sweep(), { culled: 3, held: 0 });
  assert.equal(store.calls[0][1].limit, 2);
  store.findIdleGuests = async () => { throw new Error('db down'); };
  assert.deepEqual(await c.sweep(), { failed: true });
  assert.match(logger.lines.at(-1), /^\[guests\] cull failed: .*db down/);
  store.findIdleGuests = async () => [];
  assert.deepEqual(await c.sweep(), { culled: 0, held: 0 });
});

test('a sweep while one is running does nothing', async () => {
  const { c, store } = cull();
  let release;
  store.findIdleGuests = () => new Promise((resolve) => { release = () => resolve([1]); });
  const first = c.sweep();
  assert.deepEqual(await c.sweep(), { skipped: true });
  release();
  assert.deepEqual(await first, { culled: 1, held: 0 });
});

test('start(): the first sweep after firstMs (5 minutes), then every everyMs (an hour); stop() ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  assert.deepEqual([FIRST_MS, EVERY_MS], [5 * 60 * 1000, 60 * 60 * 1000]);
  const { c, store } = cull({ idle: [] });
  const finds = () => store.calls.filter(([op]) => op === 'find').length;
  c.start();
  c.start();
  t.mock.timers.tick(FIRST_MS - 1);
  assert.equal(finds(), 0);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(finds(), 1, 'the first sweep, once');
  t.mock.timers.tick(EVERY_MS);
  await new Promise(setImmediate);
  assert.equal(finds(), 2);
  c.stop();
  t.mock.timers.tick(10 * EVERY_MS);
  await new Promise(setImmediate);
  assert.equal(finds(), 2, 'stopped');

  const short = cull({ idle: [], firstMs: 1000, everyMs: 2000 });
  short.c.start();
  for (const ms of [1000, 2000, 2000, 2000]) {
    t.mock.timers.tick(ms);
    await new Promise(setImmediate);
  }
  assert.equal(short.store.calls.length, 4, 'GUEST_CULL_FIRST_SEC / GUEST_CULL_EVERY_SEC shorten both');
  short.c.stop();
});
