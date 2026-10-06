'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePlacement, computeEloRatingChanges, ELO_MIN_RATING } = require('../src/storage/elo');
const { findUpdatedPlayerStats, prepareUpdatePlayerStatsStatement } = require('../src/storage/userStats');
const { formatUserStatsColumnName } = require('../src/storage/columns');

test('placement prefers the client standing and falls back to the outcome', () => {
  assert.equal(resolvePlacement({ placement: 3, matchOutcome: 1 }), 3);
  assert.equal(resolvePlacement({ matchOutcome: 1 }), 1);
  assert.equal(resolvePlacement({ matchOutcome: -1 }), 2);
  assert.equal(resolvePlacement({ matchOutcome: 0 }), 1);
  assert.equal(resolvePlacement(undefined), 1);
});

test('ELO is pairwise, near zero-sum and floored', () => {
  assert.deepEqual(computeEloRatingChanges([{ user_id: 1, rating: 1000, placement: 1 }]), {});
  const r = computeEloRatingChanges([
    { user_id: 1, rating: 1000, placement: 1 },
    { user_id: 2, rating: 1000, placement: 2 },
  ]);
  assert.deepEqual(r, { 1: 1016, 2: 984 });
  const tie = computeEloRatingChanges([
    { user_id: 1, rating: 1000, placement: 1 },
    { user_id: 2, rating: 1000, placement: 1 },
  ]);
  assert.deepEqual(tie, { 1: 1000, 2: 1000 });
  const floor = computeEloRatingChanges([
    { user_id: 1, rating: 2000, placement: 1 },
    { user_id: 2, rating: ELO_MIN_RATING, placement: 2 },
  ]);
  assert.equal(floor[2], ELO_MIN_RATING);
});

function row() {
  const cols = ['currency_amount', 'currency_earned_alltime', 'num_jumps_alltime', 'num_unique_planets_visited_alltime',
    'mp_num_matches_won_alltime', 'mp_num_matches_drawed_alltime', 'mp_num_matches_lost_alltime',
    'mp_currency_earned_alltime', 'mp_num_hits_dealt_alltime', 'mp_num_hits_received_alltime',
    'mp_num_misses_dealt_alltime', 'mp_average_accuracy', 'mp_num_kills_alltime',
    'mp_num_deaths_by_other_players_alltime', 'mp_num_deaths_alltime', 'mp_most_kills_in_a_match',
    'mp_longest_time_spent_alive_in_a_match_sec', 'mp_total_time_spent_in_a_match_sec_alltime',
    'mp_most_jumps_in_a_match', 'mp_num_items_stolen_alltime'];
  return Object.fromEntries(cols.map((c) => [c, 0]));
}

test('a match folds into the all-time stats', () => {
  const before = { ...row(), mp_num_hits_dealt_alltime: 3, mp_most_jumps_in_a_match: 50 };
  const out = findUpdatedPlayerStats({
    currencyDelta: 25, matchOutcome: 1, numHits: 1, numHitsReceived: 2, numMisses: 4, numKills: 1,
    numDeathsByOtherPlayers: 1, numDeaths: 2, numUniquePlayersKilled: 2, timeSpentAliveSec: 30,
    matchDurationSec: 90, numJumps: 40, numItemsStolen: 1, numUniquePlanetsVisited: 7,
  }, before);
  assert.equal(out.currency_amount.value, 25);
  assert.equal(out.mp_currency_earned_alltime.value, 25);
  assert.equal(out.mp_num_matches_won_alltime.value, 1);
  assert.equal(out.mp_average_accuracy.value, 4 / 8);
  assert.deepEqual(out.mp_most_kills_in_a_match, { value: 2, new_record: 1 });
  assert.deepEqual(out.mp_most_jumps_in_a_match, { value: 50, new_record: 0 });
  assert.equal(out.num_jumps_alltime.value, 40);
  assert.equal(out.num_unique_planets_visited_alltime.value, 7);

  const stmt = prepareUpdatePlayerStatsStatement({ a: { value: 1 }, b: { value: 2 } });
  assert.deepEqual(stmt, { fields: 'a = ?, b = ?', values: [1, 2] });
});

test('column labels read as before', () => {
  assert.equal(formatUserStatsColumnName('user_id'), 'User ID');
  assert.equal(formatUserStatsColumnName('sp_num_levels_completed_alltime'), 'Number of Levels Completed All Time (Single Player)');
  assert.equal(formatUserStatsColumnName('mp_longest_time_spent_alive_in_a_match_sec'), 'Longest Time Spent Alive in a Match Seconds (Multiplayer)');
});
