-- RJ 493: guest accounts. A guest is a users row with is_guest = 1, a generated username and no email or password;
-- POST /v1/me/upgrade gives it both and clears is_guest on the same row. Idle guests are culled (src/guests/cull.js).
--
-- 1. users.is_guest TINYINT(1) NOT NULL DEFAULT 0: every existing row is a real account.
-- 2. users.email and users.password become NULL-able, each keeping its own type, character set and collation (read
--    from INFORMATION_SCHEMA, as 0002 reads user_id's type). The UNIQUE key on email allows any number of NULLs.
-- 3. ix_users_guest_login (is_guest, last_login): the cull's scan reads only guests.
--
-- Every step checks before it acts, so a run that failed half way can simply be run again. Nothing here rewrites a
-- row: on a populated table, 1 fills the new column with its default and 2 only relaxes a constraint.

SET @has_is_guest := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_guest'
);
SET @sql := IF(@has_is_guest = 0, 'ALTER TABLE users ADD COLUMN is_guest TINYINT(1) NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(IS_NULLABLE = 'NO',
    CONCAT('ALTER TABLE users MODIFY COLUMN email ', COLUMN_TYPE,
      IF(CHARACTER_SET_NAME IS NULL, '', CONCAT(' CHARACTER SET ', CHARACTER_SET_NAME, ' COLLATE ', COLLATION_NAME)),
      ' NULL DEFAULT NULL'),
    'DO 0')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(IS_NULLABLE = 'NO',
    CONCAT('ALTER TABLE users MODIFY COLUMN password ', COLUMN_TYPE,
      IF(CHARACTER_SET_NAME IS NULL, '', CONCAT(' CHARACTER SET ', CHARACTER_SET_NAME, ' COLLATE ', COLLATION_NAME)),
      ' NULL DEFAULT NULL'),
    'DO 0')
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_guest_index := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'ix_users_guest_login'
);
SET @sql := IF(@has_guest_index = 0, 'ALTER TABLE users ADD KEY ix_users_guest_login (is_guest, last_login)', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
