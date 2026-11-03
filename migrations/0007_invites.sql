-- RJ 458 (phase A): invite links. One row per share: POST /v1/me/invites mints it, GET /v1/invites/:id and
-- POST /v1/match/join {mode: "join_user"} read it (src/storage/invites.js). Wobble Planet specs/invite-links.md, 2.4.
--
-- id is the link's 10 characters (23456789abcdefghjkmnpqrstuvwxyz), ascii_bin so a lookup is exact.
-- user_id takes users.user_id's exact type (read from INFORMATION_SCHEMA, as 0002 does), which a foreign key needs.
-- The foreign key cascades: an account's delete (RJ 473) and the guest cull (RJ 493) take its invites with it;
-- storage deleteUser also deletes them first (USER_TABLES). Expired rows are swept (storage sweepExpiredInvites).
-- Times are UTC, written by the brain from its own clock (as feedback's are).
--
-- CREATE TABLE IF NOT EXISTS: running it again changes nothing.

SET @user_id_type := (
  SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'
);
SET @sql := CONCAT(
  'CREATE TABLE IF NOT EXISTS invites (',
  '  id VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
  '  user_id ', COALESCE(@user_id_type, 'users_user_id_NOT_FOUND'), ' NOT NULL,',
  '  created_at DATETIME(3) NOT NULL,',
  '  expires_at DATETIME(3) NOT NULL,',
  '  PRIMARY KEY (id),',
  '  KEY ix_invites_user_id (user_id),',
  '  KEY ix_invites_expires_at (expires_at),',
  '  CONSTRAINT fk_invites_user_id FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
