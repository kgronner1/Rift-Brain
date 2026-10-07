-- RJ 462 (M0): hardening for the new databases, dev and alpha. Never runs on rift_brain (migrate refuses it):
-- the legacy brain still reads users.access_token until cutover.
--
-- 1. UNIQUE on users.username and users.email, unless 0001 already has a one-column unique key on each.
-- 2. user_credentials: the long-lived device credential, stored as SHA-256(token), one row per device, revocable
--    (spec 4.8). Its user_id takes users.user_id's exact type, which only 0001 knows.
-- 3. Drop users.access_token, the plaintext token the old login handed out.
--
-- Every step checks before it acts, so a run that failed half way can simply be run again.
--
-- Step 1 fails if the copy already holds duplicates. Find them first with:
--   SELECT username, COUNT(*) FROM users GROUP BY username HAVING COUNT(*) > 1;
--   SELECT email, COUNT(*) FROM users GROUP BY email HAVING COUNT(*) > 1;

SET @has_unique_username := (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND NON_UNIQUE = 0
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'username'
  ) AS unique_username_keys
);
SET @sql := IF(@has_unique_username = 0, 'ALTER TABLE users ADD UNIQUE KEY uq_users_username (username)', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_unique_email := (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND NON_UNIQUE = 0
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'email'
  ) AS unique_email_keys
);
SET @sql := IF(@has_unique_email = 0, 'ALTER TABLE users ADD UNIQUE KEY uq_users_email (email)', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @user_id_type := (
  SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'
);
SET @sql := CONCAT(
  'CREATE TABLE IF NOT EXISTS user_credentials (',
  '  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,',
  '  user_id ', COALESCE(@user_id_type, 'users_user_id_NOT_FOUND'), ' NOT NULL,',
  '  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
  '  platform VARCHAR(16) NOT NULL,',
  '  install_id VARCHAR(64) NOT NULL,',
  '  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,',
  '  last_used_at DATETIME NULL DEFAULT NULL,',
  '  revoked_at DATETIME NULL DEFAULT NULL,',
  '  PRIMARY KEY (id),',
  '  UNIQUE KEY uq_user_credentials_token_hash (token_hash),',
  '  KEY ix_user_credentials_user_id (user_id),',
  '  CONSTRAINT fk_user_credentials_user_id FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_access_token := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'access_token'
);
SET @sql := IF(@has_access_token > 0, 'ALTER TABLE users DROP COLUMN access_token', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
