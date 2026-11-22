'use strict';
// RJ 587: the payload ledger's entry rules (src/contract/payload.js), with no database: each source's ref and amount
// bounds, who may send which source, the reasons, and the whole call's shape. Wobble Planet's client holds the same
// numbers; this pins them.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/contract/payload');

const ok = (e, from = 'client') => P.checkEntry(e, from);
const reason = (e, from = 'client') => P.checkEntry(e, from).reason;

test('the numbers the client holds too', () => {
  assert.equal(P.MAX_ENTRIES, 32);
  assert.deepEqual([P.RUN_MIN, P.RUN_MAX], [1, 5000]);
  assert.deepEqual(P.ACCOLADE_AMOUNTS, [50, 100, 250, 500, 1000]);
  assert.deepEqual([P.CARRY_REF, P.CARRY_MIN, P.CARRY_MAX], ['carry', 0, 100000]);
  assert.deepEqual(P.SOURCES, ['sp_run', 'accolade', 'carry', 'legacy_sync']);
  assert.deepEqual(P.FROM_CLIENT, ['sp_run', 'accolade', 'carry']);
  assert.deepEqual(P.FROM_SERVER, ['accolade']);
  assert.deepEqual(Object.values(P.STATUS), ['applied', 'duplicate', 'rejected', 'deferred']);
  assert.deepEqual(P.REASON, {
    BAD_SOURCE: 'bad source', NOT_ALLOWED: 'source not allowed here', BAD_REF: 'bad ref', BAD_AMOUNT: 'bad amount',
    UNKNOWN_ACCOLADE: 'unknown accolade key', NO_SUCH_USER: 'no such user', NOT_RECORDED: 'accolade not recorded yet',
  });
});

test('sp_run: run:<8-40 of [A-Za-z0-9_-]>, an integer 1..5000', () => {
  assert.deepEqual(ok({ ref: 'run:abcdEFGH', source: 'sp_run', amount: 1 }), { ok: true });
  assert.equal(ok({ ref: `run:${'a_-9'.repeat(10)}`, source: 'sp_run', amount: 5000 }).ok, true, '40 characters');
  for (const ref of ['run:abcdefg', `run:${'a'.repeat(41)}`, 'run:abcd efgh', 'run:abcdefgh!', 'RUN:abcdefgh', 'abcdefgh', 'run:', 5, null, undefined]) {
    assert.equal(reason({ ref, source: 'sp_run', amount: 10 }), 'bad ref', String(ref));
  }
  for (const amount of [0, 5001, -1, 1.5, '10', null, undefined, NaN, Infinity]) {
    assert.equal(reason({ ref: 'run:abcdefgh', source: 'sp_run', amount }), 'bad amount', String(amount));
  }
});

test('accolade: accolade:<key>, exactly 50, 100, 250, 500 or 1000, from a client or a server', () => {
  for (const amount of P.ACCOLADE_AMOUNTS) {
    assert.deepEqual(ok({ ref: 'accolade:Ghost', source: 'accolade', amount }), { ok: true, accoladeKey: 'Ghost' });
    assert.deepEqual(ok({ ref: 'accolade:Ghost', source: 'accolade', amount }, 'server'), { ok: true, accoladeKey: 'Ghost' });
  }
  for (const amount of [0, 49, 75, 1001, 100.5, '100']) assert.equal(reason({ ref: 'accolade:Ghost', source: 'accolade', amount }), 'bad amount', String(amount));
  for (const ref of ['accolade:', 'accolade:Gh ost', 'accolade:Ghost;--', 'Ghost', 'accolades:Ghost', `accolade:${'G'.repeat(56)}`]) {
    assert.equal(reason({ ref, source: 'accolade', amount: 100 }), 'bad ref', ref);
  }
  assert.equal(ok({ ref: `accolade:${'G'.repeat(55)}`, source: 'accolade', amount: 100 }).ok, true, 'a 64-character ref');
});

test('carry: exactly "carry", an integer 0..100000, from a client only', () => {
  assert.deepEqual(ok({ ref: 'carry', source: 'carry', amount: 0 }), { ok: true });
  assert.deepEqual(ok({ ref: 'carry', source: 'carry', amount: 100000 }), { ok: true });
  for (const ref of ['Carry', 'carry:1', '', 'carry ']) assert.equal(reason({ ref, source: 'carry', amount: 5 }), 'bad ref', ref);
  for (const amount of [-1, 100001, 2.5, '5']) assert.equal(reason({ ref: 'carry', source: 'carry', amount }), 'bad amount', String(amount));
});

test('who may send what: legacy_sync from nobody, a server only accolade; an unknown source is a bad source', () => {
  assert.equal(reason({ ref: 'legacy:abc', source: 'legacy_sync', amount: 5 }), 'source not allowed here');
  assert.equal(reason({ ref: 'legacy:abc', source: 'legacy_sync', amount: 5 }, 'server'), 'source not allowed here');
  assert.equal(reason({ ref: 'run:abcdefgh', source: 'sp_run', amount: 5 }, 'server'), 'source not allowed here');
  assert.equal(reason({ ref: 'carry', source: 'carry', amount: 5 }, 'server'), 'source not allowed here');
  for (const source of ['spend', 'mp_match', 'SP_RUN', '', 7, null, undefined]) {
    assert.equal(reason({ ref: 'run:abcdefgh', source, amount: 5 }), 'bad source', String(source));
  }
  assert.equal(reason({ source: 'sp_run', amount: 5, ref: 'r'.repeat(65) }), 'bad ref', 'over 64 characters');
});

test('the whole call: an array of 0..32 objects, else a VALIDATION message', () => {
  assert.equal(P.checkEntries([]), null);
  assert.equal(P.checkEntries(Array.from({ length: 32 }, () => ({}))), null, 'the shape only: bad entries come back rejected');
  for (const entries of [undefined, null, {}, 'x', 5]) assert.equal(typeof P.checkEntries(entries), 'string', JSON.stringify(entries));
  assert.match(P.checkEntries(Array.from({ length: 33 }, () => ({}))), /at most 32/);
  for (const bad of [null, [], 'carry', 5, true]) assert.match(P.checkEntries([{}, bad]), /Each entry/, JSON.stringify(bad));
});
