-- RJ 504: feedback stops storing the sender's IP address (Alex, 2026-10-20), so the privacy policy need not name it.
-- The brain still reads the address for the feedback rate limits, in memory only (src/middleware/rateLimit.js).
--
-- feedback.ip goes, with every address it holds. FORCE rebuilds the table into a new data file. Without it MariaDB
-- 10.11 drops the column instantly, in the metadata alone, and each row's address stays in the old data file until
-- that row is next written.
--
-- It checks before it acts, so running it again changes nothing.
--
-- Deploying: provision.sh migrates before it restarts the brain. In those seconds a brain still running the code from
-- before RJ 504 fails each feedback insert with INTERNAL; the client keeps the entry and sends it again. Rolling the
-- code back past RJ 504 needs the column back first:
--   ALTER TABLE feedback ADD COLUMN ip VARCHAR(45) NULL DEFAULT NULL AFTER install_id;

SET @has_ip := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feedback' AND COLUMN_NAME = 'ip'
);
SET @sql := IF(@has_ip > 0, 'ALTER TABLE feedback DROP COLUMN ip, FORCE', 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
