-- The swarm's accounts, for release drill 5 (RJ 471, spec M9). DEV ONLY.
--
--   ssh ... "sudo mysql rift_brain_dev" < ops/drills/swarm_accounts.sql          on the box (docs/release-drills.md)
--   mysql <dev database> < ops/drills/swarm_accounts.sql                         anywhere else
--   { echo 'SET @swarm_count = 2000;'; cat ops/drills/swarm_accounts.sql; } | mysql <dev database>    more than 1000
--
-- Makes swarm0001 .. swarm<NNNN> (@swarm_count, default 1000), each email swarm<NNNN>@example.invalid, with the scrubbed
-- dev database's one password (riftjumpers-dev, ops/db/scrub_snapshot.sh's hash), so Wobble Planet's --net_swarm signs
-- in through POST /v1/session like any client; and the rows a new account gets (user_stats, user_accolades,
-- user_accolades_time_earned, user_player_card). Safe to re-run: an account that exists keeps its id and its
-- credentials, and gets the dev password again.
--
-- REFUSES, before it writes anything, any database but a dev one: the current database must end in _dev and name
-- neither alpha nor prod (rift_brain_dev on the box; rj_swarm_dev in ops/drills/test/drill5_local.sh). The legacy
-- rift_brain, rift_brain_alpha and a database with no name are all refused with SQLSTATE 45000.
--
-- To remove them (dev only, nothing else references them):
--   DELETE c FROM user_credentials c JOIN users u ON u.user_id = c.user_id WHERE u.username REGEXP '^swarm[0-9]{4}$';
-- and the same for user_stats, user_accolades, user_accolades_time_earned, user_player_card, then users itself.

DELIMITER //
BEGIN NOT ATOMIC
  DECLARE db VARCHAR(64) DEFAULT IFNULL(DATABASE(), '');
  DECLARE n INT DEFAULT IFNULL(@swarm_count, 1000);
  DECLARE i INT DEFAULT 1;
  IF db NOT REGEXP '_dev$' OR LOWER(db) REGEXP 'alpha|prod' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'swarm_accounts.sql refused: it runs on a dev database only (a name ending in _dev)';
  END IF;
  IF n < 1 OR n > 9999 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'swarm_accounts.sql refused: @swarm_count must be 1..9999';
  END IF;
  START TRANSACTION;
  WHILE i <= n DO
    INSERT INTO users (username, email, password, last_login, created_date)
      VALUES (CONCAT('swarm', LPAD(i, 4, '0')), CONCAT('swarm', LPAD(i, 4, '0'), '@example.invalid'),
              '$2b$10$HSHyJmHlrYq1975Uw.uPwegf10x2dJ2M7oJ.HArYmWSr2DcT90KHq', NOW(), NOW())
      ON DUPLICATE KEY UPDATE password = VALUES(password);
    SET i = i + 1;
  END WHILE;
  INSERT IGNORE INTO user_stats (user_id) SELECT user_id FROM users WHERE username REGEXP '^swarm[0-9]{4}$';
  INSERT IGNORE INTO user_accolades (user_id) SELECT user_id FROM users WHERE username REGEXP '^swarm[0-9]{4}$';
  INSERT IGNORE INTO user_accolades_time_earned (user_id) SELECT user_id FROM users WHERE username REGEXP '^swarm[0-9]{4}$';
  INSERT IGNORE INTO user_player_card (user_id) SELECT user_id FROM users WHERE username REGEXP '^swarm[0-9]{4}$';
  COMMIT;
  SELECT CONCAT(COUNT(*), ' swarm accounts in ', db, ' (password riftjumpers-dev)') AS swarm_accounts
    FROM users WHERE username REGEXP '^swarm[0-9]{4}$';
END //
DELIMITER ;
