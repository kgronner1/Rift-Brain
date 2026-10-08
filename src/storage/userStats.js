// The user_stats table: the post-match update (with ELO) and the single-player sync.
const { getDB } = require('../db');
const { loadUserStatsColumns, filterSpStatsKeys, quoteColumn } = require('./columns');
const log = require('../log');
const { ELO_DEFAULT_RATING, resolvePlacement, computeEloRatingChanges } = require('./elo');

// user_stats
// +--------------------------------------------+---------+------+-----+---------+-------+
// | Field                                      | Type    | Null | Key | Default | Extra |
// +--------------------------------------------+---------+------+-----+---------+-------+
// | user_id                                    | int(11) | NO   | PRI | NULL    |       |
// | currency_amount                            | int(11) | YES  |     | 0       |       |
// | currency_earned_alltime                    | int(11) | YES  |     | 0       |       |
// | num_jumps_alltime                          | int(11) | YES  |     | 0       |       |
// | num_unique_planets_visited_alltime         | int(11) | YES  |     | 0       |       |
// | sp_most_currency_earned_in_a_run           | int(11) | YES  |     | 0       |       |
// | sp_currency_earned_alltime                 | int(11) | YES  |     | 0       |       |
// | sp_highest_combo_alltime                   | int(11) | YES  |     | 0       |       |
// | sp_most_jumps_in_a_run                     | int(11) | YES  |     | 0       |       |
// | sp_most_unique_planets_visited_in_a_run    | int(11) | YES  |     | 0       |       |
// | sp_most_levels_completed_in_a_run          | int(11) | YES  |     | 0       |       |
// | sp_num_levels_completed_alltime            | int(11) | YES  |     | 0       |       |
// | sp_most_asteroids_hit_in_a_run             | int(11) | YES  |     | 0       |       |
// | sp_num_asteroids_hit_alltime               | int(11) | YES  |     | 0       |       |
// | sp_longest_run_sec_alltime                 | float   | YES  |     | 0       |       |
// | sp_total_time_spent_in_a_run_sec_alltime   | float   | YES  |     | 0       |       |
// | mp_num_matches_won_alltime                 | int(11) | YES  |     | 0       |       |
// | mp_num_matches_drawed_alltime              | int(11) | YES  |     | 0       |       |
// | mp_num_matches_lost_alltime                | int(11) | YES  |     | 0       |       |
// | mp_most_currency_earned_in_a_match         | int(11) | YES  |     | 0       |       |
// | mp_currency_earned_alltime                 | int(11) | YES  |     | 0       |       |
// | mp_num_hits_dealt_alltime                  | int(11) | YES  |     | 0       |       |
// | mp_num_hits_received_alltime               | int(11) | YES  |     | 0       |       |
// | mp_num_misses_dealt_alltime                | int(11) | YES  |     | 0       |       |
// | mp_average_accuracy                        | float   | YES  |     | 0       |       |
// | mp_num_kills_alltime                       | int(11) | YES  |     | 0       |       |
// | mp_num_deaths_by_other_players_alltime     | int(11) | YES  |     | 0       |       |
// | mp_num_deaths_alltime                      | int(11) | YES  |     | 0       |       |
// | mp_most_kills_in_a_match                   | int(11) | YES  |     | 0       |       |
// | mp_longest_time_spent_alive_in_a_match_sec | float   | YES  |     | 0       |       |
// | mp_total_time_spent_in_a_match_sec_alltime | float   | YES  |     | 0       |       |
// | mp_most_jumps_in_a_match                   | int(11) | YES  |     | 0       |       |
// | mp_num_items_stolen_alltime                | int(11) | YES  |     | 0       |       |
// | mp_elo_rating                              | int(11) | NO   |     | 1000    |       |
// +--------------------------------------------+---------+------+-----+---------+-------+

function prepareUpdatePlayerStatsStatement(updated_player_stats) {

  // for each key
  // if key begins with sp, continue

  const keys = Object.keys(updated_player_stats);
  const fields = keys.map(key => `${quoteColumn(key)} = ?`).join(', ');
  const values = keys.map(key => updated_player_stats[key].value);

  let update_variables = {};
  update_variables.fields = fields;
  update_variables.values = values;

  return update_variables;

}


// accepts match_stats, player_stats
// returns updated_player_stats
function findUpdatedPlayerStats(match_stats, player_stats) {

  const updated_player_stats = Object.fromEntries(
    Object.entries(player_stats).map(([key, value]) => [key, { value, new_record: 0 }])
  );

  // currency, outcome, hits, hit received, misses, kills, kill by others, deaths, num plays killed, longest time spent alive, time spent in match, jumps

  // currency
  updated_player_stats.currency_amount.value += match_stats.currencyDelta;

  if (match_stats.currencyDelta > 0) {
    updated_player_stats.mp_currency_earned_alltime.value += match_stats.currencyDelta;
    updated_player_stats.currency_earned_alltime.value += match_stats.currencyDelta;
  }

  // outcome
  if (match_stats.matchOutcome == -1) {updated_player_stats.mp_num_matches_lost_alltime.value += 1}
  else if (match_stats.matchOutcome === 0) {updated_player_stats.mp_num_matches_drawed_alltime.value += 1}
  else if (match_stats.matchOutcome == 1) {updated_player_stats.mp_num_matches_won_alltime.value += 1}

  // hits
  updated_player_stats.mp_num_hits_dealt_alltime.value += match_stats.numHits;
  updated_player_stats.mp_num_hits_received_alltime.value += match_stats.numHitsReceived;
  updated_player_stats.mp_num_misses_dealt_alltime.value += match_stats.numMisses;

  // accuracy
  const alltime_accuracy = updated_player_stats.mp_num_hits_dealt_alltime.value / Math.max(updated_player_stats.mp_num_hits_dealt_alltime.value + updated_player_stats.mp_num_misses_dealt_alltime.value, 1);
  updated_player_stats.mp_average_accuracy.value = alltime_accuracy;

  // kills
  updated_player_stats.mp_num_kills_alltime.value += match_stats.numKills;

  // deaths by others
  updated_player_stats.mp_num_deaths_by_other_players_alltime.value += match_stats.numDeathsByOtherPlayers;

  // deaths
  updated_player_stats.mp_num_deaths_alltime.value += match_stats.numDeaths;

  // kills in a match
  if (updated_player_stats.mp_most_kills_in_a_match.value < match_stats.numUniquePlayersKilled) {
    updated_player_stats.mp_most_kills_in_a_match.value = match_stats.numUniquePlayersKilled;
    updated_player_stats.mp_most_kills_in_a_match.new_record = 1;
  }

  // longest time spent alive
  if (updated_player_stats.mp_longest_time_spent_alive_in_a_match_sec.value < match_stats.timeSpentAliveSec) {
    updated_player_stats.mp_longest_time_spent_alive_in_a_match_sec.value = match_stats.timeSpentAliveSec;
    updated_player_stats.mp_longest_time_spent_alive_in_a_match_sec.new_record = 1;
  }

  // match duration
  updated_player_stats.mp_total_time_spent_in_a_match_sec_alltime.value += match_stats.matchDurationSec;

  // jumps
  if (updated_player_stats.mp_most_jumps_in_a_match.value < match_stats.numJumps) {
    updated_player_stats.mp_most_jumps_in_a_match.value = match_stats.numJumps;
    updated_player_stats.mp_most_jumps_in_a_match.new_record = 1;
  }

  updated_player_stats.num_jumps_alltime.value += match_stats.numJumps;

  // steals
  updated_player_stats.mp_num_items_stolen_alltime.value += match_stats.numItemsStolen;

  // unique planets visited
  updated_player_stats.num_unique_planets_visited_alltime.value += match_stats.numUniquePlanetsVisited;

  return updated_player_stats;

  // updated_player_stats
  //   {
  //     ...,
  //     "timeSpentAliveSec": {
  //        "value": 178.48,
  //        "newRecord": 1
  //     }
  //  }


}

// Computes each rated player's new ELO for a finished match. Returns a map of
// user_id -> new rating (empty when ELO can't/shouldn't run). Safe to call
// before the mp_elo_rating migration is applied: it no-ops until the column
// exists, so the code can be deployed ahead of the migration.
async function computeMatchEloUpdates(db, body) {
  const { set: statsColumns } = await loadUserStatsColumns();
  if (!statsColumns.has('mp_elo_rating')) return {};

  // Only logged-in players are rated, and ELO needs at least two of them.
  const placementById = new Map();
  for (const player of body) {
    const user_id = Number(player.user_id);
    if (!Number.isInteger(user_id) || user_id <= 0) continue;
    placementById.set(user_id, resolvePlacement(player.stats));
  }
  if (placementById.size < 2) return {};

  const ids = [...placementById.keys()];
  const placeholders = ids.map(() => '?').join(', ');
  const [ratingRows] = await db.execute(
    `SELECT user_id, mp_elo_rating FROM user_stats WHERE user_id IN (${placeholders});`,
    ids
  );
  const ratingById = new Map(ratingRows.map(r => [Number(r.user_id), Number(r.mp_elo_rating)]));

  const participants = ids.map(user_id => ({
    user_id,
    rating: ratingById.has(user_id) ? ratingById.get(user_id) : ELO_DEFAULT_RATING,
    placement: placementById.get(user_id),
  }));

  return computeEloRatingChanges(participants);
}

// updates the players stats after a game
// multiple plays could be passed
async function postMatchPlayerStatsUpdate(body) {

  // body
  // [{user_id: 1, stats: {currencyDelta: -250, matchOutcome: 1, ...}, {user_id: 2, stats: {currencyDelta: 250, matchOutcome: -1, ...}]

  // body.stats
  // "currencyDelta": 0,
  // "matchOutcome": 0,
  // "numJumps": 0,
  // "numHits": 0,
  // "numMisses": 0,
  // "numHitsReceived": 0,
  // "numKills": 0,
  // "numUniquePlayersKilled": 0,
  // "numDeaths": 0,
  // "numDeathsByOtherPlayers": 0,
  // "matchDurationSec": 0,
  // "timeSpentAliveSec": 0
  // enum MatchOutcome {
  //   LOSS = -1,
  //   DRAW = 0,
  //   WIN = 1
  // }

  let response = [];

  const db = getDB();

  // Compute ELO rating changes across the whole match up front, so every
  // player's new rating already accounts for the entire lobby before we write
  // per-player stat rows. Empty when ELO can't run (pre-migration, <2 rated).
  const eloByUser = await computeMatchEloUpdates(db, body);

  // for each player
    // calculate and update their all time stats
  for (const player of body) {

    const user_id = player.user_id;
    let match_stats = player.stats;

    try {

      const query = `SELECT * FROM user_stats WHERE user_id = ?`;
      // Fetch the user from the database
      let [resp] = await db.execute(query, [user_id]);
      const player_stats = resp[0];

      if (!player_stats) {

        throw new Error('No matching user stats found.');

      }
      else {

        // remove all single player stats and the user_id
        for (const key in player_stats) {
          if (key.startsWith('sp_') || key == "user_id") {
            delete player_stats[key];
          }
        }

        // create update statement
        let updated_player_stats = findUpdatedPlayerStats(match_stats, player_stats);

        // Fold in this player's new ELO (if any). mp_elo_rating flows through
        // findUpdatedPlayerStats as a normal column, so we just overwrite its
        // value before the UPDATE statement is built. Guarded so it's a no-op
        // when the column doesn't exist yet.
        const new_elo_rating = eloByUser[user_id];
        if (new_elo_rating !== undefined && updated_player_stats.mp_elo_rating !== undefined) {
          updated_player_stats.mp_elo_rating.value = new_elo_rating;
        }

        let update_variables = prepareUpdatePlayerStatsStatement(updated_player_stats);

        try {

          const queryUpdate = `
            UPDATE user_stats
            SET ${update_variables.fields}
            WHERE user_id = ?;
          `;

          update_variables.values.push(user_id);

          const [result] = await db.execute(queryUpdate, update_variables.values);

          // remove user id and last updated from stats object
          delete updated_player_stats.user_id;
          delete updated_player_stats._last_updated;

          response.push({"user_id": user_id, "stats": updated_player_stats});

        } catch (error) {

          log.error('Error updating player stats after match:', error.message);
          throw error;

        }
      }

    } catch (error) {
        log.error('Error finding player from user_id when updating player stats after match:', error.message);
        throw error;
    }

  }

  return response;

}

// The single-player sync: when the client's _last_updated is newer than the row's, its sp_ and currency columns
// replace the database's. Only keys filterSpStatsKeys() allows reach SQL; the rest come back in ignored_keys.
// body: {user_id, stats: {KEY: VALUE, ..., _last_updated}}. Returns {user_id, user_stats, ignored_keys}.
async function singlePlayerStatsSync(body) {

  if (!body.user_id) {
    throw new Error('Missing required field: user_id');
  }

  const db = getDB();
  const user_id = body.user_id;
  const stats = body.stats && typeof body.stats === 'object' && !Array.isArray(body.stats) ? body.stats : {};
  const { set: columns } = await loadUserStatsColumns();
  const { keys: updateKeys, ignored: ignored_keys } = filterSpStatsKeys(stats, columns);
  const lastUpdated = Number(stats._last_updated);

  if (Number.isFinite(lastUpdated) && lastUpdated > 0 && updateKeys.length > 0) {
    const [staleRows] = await db.execute(
      `SELECT user_id FROM user_stats WHERE user_id = ? AND UNIX_TIMESTAMP(_last_updated) < ?;`,
      [user_id, lastUpdated]
    );

    // A row older than the client's copy: the client's is fresher, so it wins.
    if (staleRows.length > 0) {
      const fields = updateKeys.map(key => `${quoteColumn(key)} = ?`).join(', ');
      const values = updateKeys.map(key => stats[key]);
      values.push(user_id);
      await db.execute(
        `UPDATE user_stats SET ${fields}, _last_updated = NOW() WHERE user_id = ?;`,
        values
      );
    }
  }

  const [rows] = await db.execute(
    `SELECT * FROM user_stats WHERE user_id = ?;`,
    [user_id]
  );

  if (!rows[0]) {
    throw new Error('No matching user stats found.');
  }

  delete rows[0].user_id;
  delete rows[0]._last_updated;

  return { "user_id": user_id, "user_stats": rows[0], ignored_keys };

}

module.exports = {
  prepareUpdatePlayerStatsStatement,
  findUpdatedPlayerStats,
  computeMatchEloUpdates,
  postMatchPlayerStatsUpdate,
  singlePlayerStatsSync,
};
