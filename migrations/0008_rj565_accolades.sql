-- RJ 565 (Wobble Planet): seventeen new accolades -- single player's Contested kills and EFFICIENCY families, and
-- multiplayer's mine accolades and Ditto (the sheet's Accolades tab, rows 71-88) -- and the all-time total Bounty Hunter
-- reads, and the per-run best beside it.
--
-- 1. user_accolades gains one earn-count column per accolade and user_accolades_time_earned one first-earned time, as
--    0001 holds every other accolade. Both column lists are read from INFORMATION_SCHEMA (src/storage/columns.js), so a
--    new column is a valid accolade key within the cache's five minutes, with no code change.
-- 2. user_stats.sp_num_rivals_killed_alltime and sp_most_rivals_killed_in_a_run: rivals the player killed across
--    every single-player Contested run, and the most in one. The client syncs both with its other sp_ stats (POST /v1/me/sp-stats/sync -- filterSpStatsKeys() takes any sp_ column),
--    and the leaderboard and the stats columns list it as they do every column. The stats column list is cached for
--    the brain's life, so the brain is restarted after this runs (provision_box.sh restarts it).
--
-- ADD COLUMN IF NOT EXISTS (MariaDB 10.0.2+): running it again changes nothing. Nothing here rewrites a row.

ALTER TABLE user_accolades
  ADD COLUMN IF NOT EXISTS `FirstBlood` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `EasyStreet` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `PieceofCake` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `Bulldozer` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `BountyHunter` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `Ditto` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `Demolitionist` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `TwoBirds` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `ChainReaction` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `BaitandSwitch` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `EcoFriendly` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `GreenerMachine` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `CleanSheet` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `Pathfinder` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `WalktheLine` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `RidetheLine` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `Navigator` int(10) unsigned NOT NULL DEFAULT 0;

ALTER TABLE user_accolades_time_earned
  ADD COLUMN IF NOT EXISTS `FirstBlood` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `EasyStreet` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `PieceofCake` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `Bulldozer` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `BountyHunter` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `Ditto` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `Demolitionist` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `TwoBirds` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `ChainReaction` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `BaitandSwitch` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `EcoFriendly` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `GreenerMachine` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `CleanSheet` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `Pathfinder` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `WalktheLine` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `RidetheLine` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `Navigator` timestamp NULL DEFAULT NULL;

ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS `sp_num_rivals_killed_alltime` int(11) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `sp_most_rivals_killed_in_a_run` int(11) DEFAULT 0;
