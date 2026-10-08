'use strict';
// SQL hardening (spec M3): only known columns reach SQL, as backtick-quoted names; everything else is ignored.
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterSpStatsKeys, quoteColumn } = require('../src/storage/columns');
const { filterAccoladeKeys } = require('../src/storage/accolades');

const STATS = new Set(['user_id', 'currency_amount', 'currency_earned_alltime', 'num_jumps_alltime',
  'sp_most_jumps_in_a_run', 'sp_longest_run_sec_alltime', 'mp_num_kills_alltime', '_last_updated']);

test('single-player sync keys: a column, and sp_ or a currency column, with a number', () => {
  const r = filterSpStatsKeys({
    _last_updated: 1790000000,
    sp_most_jumps_in_a_run: 12,
    sp_longest_run_sec_alltime: 3.5,
    currency_amount: 40,
    "sp_x = 1, password = 'x'": 1,
    'sp_most_jumps_in_a_run`=1,`currency_amount': 1,
    mp_num_kills_alltime: 99,
    num_jumps_alltime: 5,
    user_id: 2,
    sp_not_a_column: 1,
    currency_earned_alltime: '9',
  }, STATS);
  assert.deepEqual(r.keys, ['sp_most_jumps_in_a_run', 'sp_longest_run_sec_alltime', 'currency_amount']);
  assert.deepEqual(r.ignored, ["sp_x = 1, password = 'x'", 'sp_most_jumps_in_a_run`=1,`currency_amount', 'mp_num_kills_alltime',
    'num_jumps_alltime', 'user_id', 'sp_not_a_column', 'currency_earned_alltime']);
  assert.deepEqual(filterSpStatsKeys(null, STATS), { keys: [], ignored: [] });
  assert.deepEqual(filterSpStatsKeys([1], STATS), { keys: [], ignored: [] });
});

test('accolade sync keys: a user_accolades column with a non-negative integer', () => {
  const cols = new Set(['Beaming', 'Ghost', 'FTL']);
  const r = filterAccoladeKeys({ _last_updated: 1, Beaming: 2, Ghost: -1, FTL: 1.5, 'Beaming = 0 --': 1, user_id: 3, Nope: 1 }, cols);
  assert.deepEqual(r.keys, ['Beaming']);
  assert.deepEqual(r.ignored, ['Ghost', 'FTL', 'Beaming = 0 --', 'user_id', 'Nope']);
});

test('quoteColumn backtick-quotes a checked name and refuses anything else', () => {
  assert.equal(quoteColumn('sp_x'), '`sp_x`');
  assert.equal(quoteColumn('_last_updated'), '`_last_updated`');
  for (const bad of ['a b', 'a`b', '', 'x'.repeat(65), "a'", null]) assert.throws(() => quoteColumn(bad), /refusing/);
});
