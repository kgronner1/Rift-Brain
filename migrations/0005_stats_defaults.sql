-- RJ 495: the two user_stats columns 0001 left DEFAULT NULL default to 0, as every other stat does.
--
-- A row begins as INSERT INTO user_stats (user_id): a new account, or a guest (RJ 493) made from an empty save, keeps
-- NULL in num_jumps_alltime and mp_num_items_stolen_alltime until its device uploads them, and a client reading its
-- personal stats crashed on the null. The NULLs already there become 0 first.
--
-- Both statements are safe to run again: the UPDATE finds nothing, and SET DEFAULT sets the same default.

UPDATE user_stats SET num_jumps_alltime = 0 WHERE num_jumps_alltime IS NULL;
UPDATE user_stats SET mp_num_items_stolen_alltime = 0 WHERE mp_num_items_stolen_alltime IS NULL;
ALTER TABLE user_stats
  ALTER COLUMN num_jumps_alltime SET DEFAULT 0,
  ALTER COLUMN mp_num_items_stolen_alltime SET DEFAULT 0;
