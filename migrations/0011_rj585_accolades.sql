-- RJ 585 (Wobble Planet): three new multiplayer accolades (the sheet's Accolades tab, rows 88-90) -- Gloves Off (win 10
-- STOCK matches) and Wolves at Bay (win 10 DOMINATION matches), which read 0010's per-mode win counts, and Who's House?
-- (win a DOMINATION match in which no opponent took the hill).
--
-- user_accolades gains one earn-count column per accolade and user_accolades_time_earned one first-earned time, as
-- 0001 and 0008 hold every other accolade. Both column lists are read from INFORMATION_SCHEMA (src/storage/columns.js),
-- so a new column is a valid accolade key within the cache's five minutes, with no code change. Nothing in user_stats:
-- Who's House?'s hill takes reach the brain in the match's stats, which findUpdatedPlayerStats() never reads.
--
-- ADD COLUMN IF NOT EXISTS (MariaDB 10.0.2+): running it again changes nothing. Nothing here rewrites a row.

ALTER TABLE user_accolades
  ADD COLUMN IF NOT EXISTS `GlovesOff` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `WolvesatBay` int(10) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `WhosHouse` int(10) unsigned NOT NULL DEFAULT 0;

ALTER TABLE user_accolades_time_earned
  ADD COLUMN IF NOT EXISTS `GlovesOff` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `WolvesatBay` timestamp NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `WhosHouse` timestamp NULL DEFAULT NULL;
