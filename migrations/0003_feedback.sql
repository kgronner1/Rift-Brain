-- RJ 488: in-game player feedback (Wobble Planet specs/player-feedback.md, "The data"). The database is the source of
-- truth; the forwarder (src/feedback/forwarder.js, RJ 489) copies rows to the Player Feedback sheet.
--
-- utf8mb4: the tables 0001 made are latin1, and a player's emoji must survive.
-- user_id is INT(11), users.user_id's type, with no foreign key: an account's hard delete (RJ 473) must never cascade
-- into feedback, which is kept and made anonymous (storage/feedback.js, anonymizeFeedbackForUser).
-- sheet_sent_at is not in the plan's table: it is when the sheet confirmed the row, and the forwarder's daily cap
-- (server.feedback_sheet_per_day) counts it, so the cap survives a brain restart.
--
-- CREATE TABLE IF NOT EXISTS: running it again changes nothing.

CREATE TABLE IF NOT EXISTS feedback (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  received_at DATETIME(3) NOT NULL,
  written_at VARCHAR(40) NULL DEFAULT NULL,
  user_id INT(11) NULL DEFAULT NULL,
  username VARCHAR(64) NULL DEFAULT NULL,
  install_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NULL DEFAULT NULL,
  ip VARCHAR(45) NULL DEFAULT NULL,
  build INT NULL DEFAULT NULL,
  platform VARCHAR(16) NULL DEFAULT NULL,
  env VARCHAR(8) NOT NULL,
  tags VARCHAR(64) NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  context TEXT NOT NULL,
  sheet_state ENUM('pending', 'sent', 'anon_pending', 'done_anon') NOT NULL DEFAULT 'pending',
  sheet_attempts INT NOT NULL DEFAULT 0,
  sheet_next_at DATETIME(3) NULL DEFAULT NULL,
  sheet_sent_at DATETIME(3) NULL DEFAULT NULL,
  anonymized_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY ix_feedback_sheet (sheet_state, sheet_next_at),
  KEY ix_feedback_sent (sheet_sent_at),
  KEY ix_feedback_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
