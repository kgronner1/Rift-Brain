-- Adds the ELO rating column used by ELO-driven matchmaking (RJ 203).
--
-- Every player starts at 1000. mp_elo_rating is updated after each public
-- (non-private) multiplayer match by postMatchPlayerStatsUpdate() in
-- src/storage.js, using a placement-based pairwise ELO across the lobby.
--
-- Rollout (deploy-before-migrate is safe -- the code no-ops on ELO until this
-- column exists):
--   1. Deploy the updated Rift-Brain code.
--   2. Apply this migration:  mysql -u USER -p rift_brain < migrations/2026-08-12_add_mp_elo_rating.sql
--   3. Restart the node process so storage.js re-reads the user_stats columns:
--        pm2 restart rift-brain
--
-- Existing rows are backfilled to the 1000 default by the ADD COLUMN itself.
-- The column is appended at the end of the table -- position is cosmetic and the
-- app references columns only by name, so no AFTER anchor is used (an anchor that
-- doesn't match a live column would abort the whole ALTER and add nothing).

ALTER TABLE user_stats
  ADD COLUMN mp_elo_rating INT NOT NULL DEFAULT 1000;

-- Confirm the column now exists (prints one row on success, none on failure).
SHOW COLUMNS FROM user_stats LIKE 'mp_elo_rating';
