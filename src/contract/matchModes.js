'use strict';
// RJ 585: the game modes a game server names in each /internal/v1/match/results entry ("mode"), and the user_stats
// column a WIN in each adds one to (migrations/0010_rj585_mode_wins.sql). The keys are Wobble Planet's
// GameConfig.modeKey(): its Mode enum's own words, lower-cased -- never the on-screen labels, which have been renamed
// before. Change them in both repos together. A mode the game adds later counts toward no mode here until it has a key
// and a column (Wobble Planet's docs/game-modes.md, "How to add a game mode").

const MODE_WIN_COLUMNS = Object.freeze({
  stock: 'mp_num_stock_matches_won_alltime',
  domination: 'mp_num_domination_matches_won_alltime',
  time: 'mp_num_time_matches_won_alltime',
});

const MATCH_MODES = Object.freeze(Object.keys(MODE_WIN_COLUMNS));

// The mode an entry names, or null: no mode (a game server before RJ 585) and anything that is not one of the keys
// above (another type, another case, a mode this brain does not know) are all "no mode". Pure.
function matchModeOf(value) {
  return typeof value === 'string' && Object.hasOwn(MODE_WIN_COLUMNS, value) ? value : null;
}

// The user_stats column a win in `mode` adds to, or null for no mode.
function modeWinColumn(mode) {
  const key = matchModeOf(mode);
  return key ? MODE_WIN_COLUMNS[key] : null;
}

module.exports = { MODE_WIN_COLUMNS, MATCH_MODES, matchModeOf, modeWinColumn };
