-- RJ 585 (Wobble Planet): a multiplayer win counts toward its game mode as well as toward mp_num_matches_won_alltime.
-- The game server names the mode in each /internal/v1/match/results entry ("mode": "stock" | "domination" | "time",
-- src/contract/matchModes.js); a WIN (matchOutcome 1) adds one to that mode's column in the same write as the overall
-- count. A report with no mode, or a mode the brain does not know, adds to none of them. The lifetime accolades Gloves
-- Off and Wolves at Bay read these from the all-time stats match/results answers with.
--
-- No backfill: the brain has never kept a match's mode, so every row starts at 0.
--
-- The three sit after mp_num_matches_won_alltime, so the leaderboard's list of columns shows them beside it. The stats
-- column list is cached for the brain's life, so the brain is restarted after this runs (provision_box.sh restarts it).
--
-- ADD COLUMN IF NOT EXISTS (MariaDB 10.0.2+): running it again changes nothing. Nothing here rewrites a row.

ALTER TABLE user_stats
  ADD COLUMN IF NOT EXISTS `mp_num_stock_matches_won_alltime` int(11) NOT NULL DEFAULT 0 AFTER `mp_num_matches_won_alltime`,
  ADD COLUMN IF NOT EXISTS `mp_num_domination_matches_won_alltime` int(11) NOT NULL DEFAULT 0 AFTER `mp_num_stock_matches_won_alltime`,
  ADD COLUMN IF NOT EXISTS `mp_num_time_matches_won_alltime` int(11) NOT NULL DEFAULT 0 AFTER `mp_num_domination_matches_won_alltime`;
