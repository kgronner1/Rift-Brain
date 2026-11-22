-- RJ 587: the server-held payload balance. One row per payload change, keyed by an entry id (`ref`) that counts once
-- per account (Wobble Planet's rj587 spec). src/storage/payloadLedger.js writes it: POST /v1/me/payload/credit,
-- POST /internal/v1/payload/credit, and the single-player sync's legacy branch. user_stats.currency_amount and
-- currency_earned_alltime stay the running totals, updated in the same transaction as each row.
--
-- source: sp_run | accolade | carry | legacy_sync (src/contract/payload.js holds the rules). amount is signed (nothing
-- negative is accepted yet); balance_after is currency_amount after the row, for audit. No backfill: the opening
-- balance is what user_stats holds when this runs.
-- user_id takes users.user_id's exact type (read from INFORMATION_SCHEMA, as 0007 does), which a foreign key needs.
-- The foreign key cascades: an account's delete (RJ 473) and the guest cull (RJ 493) take its rows with it; storage
-- deleteUser also deletes them first (USER_TABLES). ref and source are ascii_bin, so a ref matches exactly.
--
-- CREATE TABLE IF NOT EXISTS: running it again changes nothing.

SET @user_id_type := (
  SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'
);
SET @sql := CONCAT(
  'CREATE TABLE IF NOT EXISTS payload_ledger (',
  '  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,',
  '  user_id ', COALESCE(@user_id_type, 'users_user_id_NOT_FOUND'), ' NOT NULL,',
  '  ref VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
  '  source VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,',
  '  amount INT NOT NULL,',
  '  balance_after INT NOT NULL,',
  '  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,',
  '  PRIMARY KEY (id),',
  '  UNIQUE KEY uq_payload_ledger_user_ref (user_id, ref),',
  '  KEY ix_payload_ledger_user_created (user_id, created_at),',
  '  CONSTRAINT fk_payload_ledger_user_id FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
