// // // // // // // // ELO RATING // // // // // // // //
// Pure: the database half is computeMatchEloUpdates() in userStats.js.

// Every rated player starts here; matches the mp_elo_rating column default.
const ELO_DEFAULT_RATING = 1000;
// Max points a single match can move a rating (classic chess K-factor).
const ELO_K_FACTOR = 32;
// Ratings never fall below this floor.
const ELO_MIN_RATING = 100;

// Prefer the client-computed final standing (1 = best). Older clients that don't
// send a placement fall back to a coarse standing derived from WIN/DRAW/LOSS.
function resolvePlacement(stats) {
  const placement = Number(stats && stats.placement);
  if (Number.isInteger(placement) && placement > 0) return placement;

  const outcome = Number(stats && stats.matchOutcome);
  if (outcome > 0) return 1; // WIN
  if (outcome < 0) return 2; // LOSS
  return 1;                  // DRAW (tie)
}

// Generalized (pairwise) ELO for a free-for-all match: each participant is
// compared against every other, scoring 1 for a better placement, 0 for worse,
// 0.5 for a tie. Per-opponent deltas are averaged so a player's swing stays in
// the familiar 1v1 range regardless of lobby size. Ratings are zero-sum (aside
// from integer rounding) and floored at ELO_MIN_RATING.
// participants: [{ user_id, rating, placement }]  ->  { [user_id]: newRating }
function computeEloRatingChanges(participants) {
  const results = {};
  const n = participants.length;
  if (n < 2) return results;

  for (const a of participants) {
    let delta = 0;
    for (const b of participants) {
      if (b === a) continue;
      const expected = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
      let actual;
      if (a.placement < b.placement) actual = 1;
      else if (a.placement > b.placement) actual = 0;
      else actual = 0.5;
      delta += actual - expected;
    }
    delta = (ELO_K_FACTOR * delta) / (n - 1);
    results[a.user_id] = Math.max(ELO_MIN_RATING, Math.round(a.rating + delta));
  }
  return results;
}

module.exports = {
  ELO_DEFAULT_RATING,
  ELO_K_FACTOR,
  ELO_MIN_RATING,
  resolvePlacement,
  computeEloRatingChanges,
};
