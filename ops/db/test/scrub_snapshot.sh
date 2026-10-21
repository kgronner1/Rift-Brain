#!/usr/bin/env bash
# Grades ops/db/scrub_snapshot.sh table by table (RJ 511) against MariaDB 10.11 in Docker. rift_brain_dev is built by
# the brain's own migrate and given what a player leaves in every table: two real accounts, a guest, a device
# credential each, a signed-in and an anonymous feedback entry, stats, accolades and a player card. Graded:
#   - a sweep of every string column of every table finds each of those player details before any scrub (the
#     sweep's positive control), and none after one
#   - a copy into a new database is scrubbed, every kept table equal to dev's, and dev is untouched
#   - a table, a users column, or a string column in a kept table that the script does not name fails the scrub,
#     PLAN included, copying and changing nothing; a new number column (the next accolade) passes
#   - a copy that fails part way is dropped, and so is its dump
#   - in place: an anon_pending feedback row refuses; a pending one warns; then nothing that names a player is left,
#     the kept tables are unchanged, a re-run changes nothing, and the brain's feedback code still works on it
# infra/test/provision_db.sh grades the rest: the refusals by name, the printed password signing in, a legacy copy.
#
#   bash ops/db/test/scrub_snapshot.sh
#
# Needs Docker and node_modules. The container is RJ_TEST_CONTAINER (default rj-scrub-test-<pid>) on host port
# RJ_TEST_PORT (default: any free one); it is removed on every exit path.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${MARIADB_IMAGE:-mariadb:10.11}"
NAME="${RJ_TEST_CONTAINER:-rj-scrub-test-$$}"
PW="rjtest$(openssl rand -hex 8)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-scrub-test.XXXXXX")"
mkdir -p "$WORK/tmp"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PASSES=0
pass() { echo "PASS $*"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*"; exit 1; }

docker run -d --name "$NAME" -e MARIADB_ROOT_PASSWORD="$PW" -p "127.0.0.1:${RJ_TEST_PORT:-}:3306" "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 3306/tcp | head -n 1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  docker exec "$NAME" mariadb -uroot -p"$PW" -e 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
sql() { docker exec -i "$NAME" mariadb -uroot -p"$PW" --batch --skip-column-names "$@"; }
scrub() {
  TMPDIR="$WORK/tmp" RJ_MYSQL_ADMIN="docker exec -i $NAME mariadb -uroot -p$PW" \
    RJ_MYSQLDUMP_ADMIN="docker exec -i $NAME mariadb-dump -uroot -p$PW" \
    bash "$REPO_DIR/ops/db/scrub_snapshot.sh" "$@"
}
db_exists() { [ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$1'")" = 1 ]; }
# Every table's rows, checksummed, without the database's name: equal for a database and an exact copy of it.
db_sum() {
  local list
  list="$(sql -e "SELECT GROUP_CONCAT(CONCAT('\`$1\`.\`', TABLE_NAME, '\`') ORDER BY TABLE_NAME)
                  FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$1'")"
  sql -e "CHECKSUM TABLE $list" | sed "s/^$1\.//"
}
KEPT="user_stats user_accolades user_accolades_time_earned user_player_card schema_migrations"
kept_sum() {
  local list="" t
  for t in $KEPT; do list="$list${list:+, }\`$1\`.\`$t\`"; done
  sql -e "CHECKSUM TABLE $list" | sed "s/^$1\.//"
}
# Every player detail put in below carries "zq" or starts 0b0e7c1e (the feedback install ids, which must be UUIDs).
NEEDLES='zq|0b0e7c1e'
# "table.column" for every string column of <db> where a needle is found; nothing when there is none.
leaks() {
  local cols q="" t c
  cols="$(sql -e "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='$1'
                  AND DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext','enum','set','json')")"
  while IFS=$'\t' read -r t c; do
    [ -n "$t" ] || continue
    q="$q${q:+ UNION ALL }SELECT DISTINCT '$t.$c' FROM \`$1\`.\`$t\` WHERE \`$c\` REGEXP '$NEEDLES'"
  done <<<"$cols"
  sql -e "$q" | sort
}

# --- rift_brain_dev, built by migrate and filled ------------------------------------------------------------------
sql -e 'CREATE DATABASE rift_brain_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
(cd "$WORK" && ENV=dev MYSQL_HOST=127.0.0.1 MYSQL_PORT="$PORT" MYSQL_USER=root MYSQL_PASSWORD="$PW" \
  MYSQL_DATABASE=rift_brain_dev node "$REPO_DIR/src/migrate.js") >"$WORK/migrate.log" 2>&1 \
  || { cat "$WORK/migrate.log"; fail "migrate rift_brain_dev"; }

# Users 1 and 2 are real accounts, 3 is a real player who chose the name "user1", 4 is a guest.
sql rift_brain_dev <<'SQL'
INSERT INTO users (username, email, password) VALUES
  ('zqannmarie', 'zqannmarie@real.test', 'zqhash-ann'),
  ('zqbob', 'zqbob@real.test', 'zqhash-bob'),
  ('user1', 'zqreal-user1@real.test', 'zqhash-user1');
INSERT INTO users (username, is_guest) VALUES ('Pilot-4321', 1);
INSERT INTO user_credentials (user_id, token_hash, platform, install_id) VALUES
  (1, REPEAT('a', 64), 'android', 'zqcred-install-ann'),
  (4, REPEAT('b', 64), 'ios', 'zqcred-install-guest');
INSERT INTO user_stats (user_id, currency_amount, num_jumps_alltime) VALUES (1, 120, 900), (2, 5, 40), (3, 0, 0), (4, 7, 70);
INSERT INTO user_accolades (user_id, Beaming, Jumpy) VALUES (1, 3, 1), (4, 1, 0);
INSERT INTO user_accolades_time_earned (user_id, Beaming) VALUES (1, '2026-10-01 12:00:00');
INSERT INTO user_player_card (user_id, equipped_accolade_key) VALUES (1, 'Beaming');
INSERT INTO feedback (id, received_at, written_at, user_id, username, install_id, build, platform, env, tags, message,
                      context, sheet_state, sheet_sent_at) VALUES
  ('11111111-1111-4111-8111-111111111111', '2026-10-19 10:00:00.000', '2026-10-19T03:00:00-07:00', 1, 'zqannmarie',
   '0b0e7c1e-5ca1-4e00-9d00-00000000feed', 512, 'android', 'dev', 'bug',
   'zqmsg the jump froze. I am Ann Marie, write to zqannmarie@real.test', '{"device":"zqPixel 9","os":"Android 15"}',
   'sent', '2026-10-19 10:00:30.000'),
  ('22222222-2222-4222-8222-222222222222', '2026-10-19 11:00:00.000', NULL, NULL, NULL,
   '0b0e7c1e-5ca1-4e00-9d00-00000000a404', 512, 'ios', 'dev', '', 'zqmsg anonymous: love it', '{"device":"zqiPhone 16"}',
   'pending', NULL);
INSERT INTO feedback (id, received_at, user_id, username, install_id, env, message, context, sheet_state, anonymized_at)
  VALUES ('33333333-3333-4333-8333-333333333333', '2026-10-19 12:00:00.000', NULL, NULL, NULL, 'dev',
          'zqmsg sent before the account was deleted', '{"device":"zqGalaxy"}', 'anon_pending', '2026-10-19 12:30:00.000');
SQL

EXPECTED_LEAKS="feedback.context
feedback.install_id
feedback.message
feedback.username
user_credentials.install_id
users.email
users.password
users.username"
[ "$(leaks rift_brain_dev)" = "$EXPECTED_LEAKS" ] || fail "the sweep's control: before any scrub it found $(leaks rift_brain_dev | tr '\n' ' ')"
pass "control: the sweep finds the player details in all 8 columns that hold them, before any scrub"

DEV_SUM="$(db_sum rift_brain_dev)"

# --- the guard: what the script does not name stops it ------------------------------------------------------------
guard_fails() { # <what it must name> -- the copy's PLAN and --apply, and the in-place --apply, each fail naming it
  local what="$1" flag
  for flag in "" --apply; do
    if scrub dev rj_scrub_guard ${flag:+"$flag"} >"$WORK/guard.log" 2>&1; then
      cat "$WORK/guard.log"; fail "a copy's ${flag:-PLAN} went ahead past $what"
    fi
    grep -q "does not know how to scrub: $what" "$WORK/guard.log" || { cat "$WORK/guard.log"; fail "the copy's ${flag:-PLAN} did not name $what"; }
  done
  ! db_exists rj_scrub_guard || fail "a refused copy left rj_scrub_guard behind ($what)"
  if scrub dev rift_brain_dev --apply >"$WORK/guard.log" 2>&1; then cat "$WORK/guard.log"; fail "in place went ahead past $what"; fi
  grep -q "does not know how to scrub: $what" "$WORK/guard.log" || { cat "$WORK/guard.log"; fail "in place did not name $what"; }
}

sql rift_brain_dev -e "CREATE TABLE player_notes (user_id INT NOT NULL, note TEXT NOT NULL); INSERT INTO player_notes VALUES (1, 'zqnote')"
NOTES_SUM="$(db_sum rift_brain_dev)"
guard_fails "table player_notes"
[ "$(db_sum rift_brain_dev)" = "$NOTES_SUM" ] || fail "a refused scrub changed rift_brain_dev (table player_notes)"
sql rift_brain_dev -e "DROP TABLE player_notes"
pass "a table the script does not name (player_notes) fails PLAN and --apply, copied or in place; nothing copied or changed"

sql rift_brain_dev -e "ALTER TABLE users ADD COLUMN phone VARCHAR(32) NULL"
guard_fails "column users.phone"
sql rift_brain_dev -e "ALTER TABLE users DROP COLUMN phone"
sql rift_brain_dev -e "ALTER TABLE user_stats ADD COLUMN country CHAR(2) NULL"
guard_fails "column user_stats.country"
sql rift_brain_dev -e "ALTER TABLE user_stats DROP COLUMN country"
[ "$(db_sum rift_brain_dev)" = "$DEV_SUM" ] || fail "a refused scrub changed rift_brain_dev (columns)"
pass "a users column it does not name (phone) and a string column new to a kept table (user_stats.country) fail the same way"

sql rift_brain_dev -e "ALTER TABLE user_accolades ADD COLUMN ZqNextAccolade INT UNSIGNED NOT NULL DEFAULT 0"
scrub dev rj_scrub_guard >"$WORK/guard-ok.log" 2>&1 || { cat "$WORK/guard-ok.log"; fail "a new number column stopped the scrub"; }
{ grep -q 'rift_brain_dev: every table and column is one the scrub knows' "$WORK/guard-ok.log" \
  && grep -q 'PLAN: CREATE DATABASE rj_scrub_guard' "$WORK/guard-ok.log"; } || { cat "$WORK/guard-ok.log"; fail "the copy's PLAN"; }
sql rift_brain_dev -e "ALTER TABLE user_accolades DROP COLUMN ZqNextAccolade"
! db_exists rj_scrub_guard || fail "a PLAN created rj_scrub_guard"
pass "control: a new number column in a kept table (the next accolade) passes the guard"

# --- a copy that fails part way is dropped ------------------------------------------------------------------------
# A trigger the dump carries into the copy fails the scrub's UPDATE there, after the copy is made.
sql rift_brain_dev -e "CREATE TRIGGER zq_block BEFORE UPDATE ON users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'zq blocked'"
if scrub dev rj_scrub_broken --apply >"$WORK/broken.log" 2>&1; then cat "$WORK/broken.log"; fail "the blocked scrub passed"; fi
grep -q 'copying rift_brain_dev into rj_scrub_broken' "$WORK/broken.log" || { cat "$WORK/broken.log"; fail "the copy was never made"; }
grep -q 'dropped rj_scrub_broken, the copy this run made' "$WORK/broken.log" || { cat "$WORK/broken.log"; fail "no drop reported"; }
! db_exists rj_scrub_broken || fail "the failed copy rj_scrub_broken is still there"
[ -z "$(ls -A "$WORK/tmp")" ] || fail "the dump outlived the run: $(ls -A "$WORK/tmp")"
sql rift_brain_dev -e "DROP TRIGGER zq_block"
if TMPDIR="$WORK/tmp" RJ_MYSQL_ADMIN="docker exec -i $NAME mariadb -uroot -p$PW" \
  RJ_MYSQLDUMP_ADMIN="docker exec -i $NAME mariadb-dump -uroot -pnot-the-password" \
  bash "$REPO_DIR/ops/db/scrub_snapshot.sh" dev rj_scrub_broken --apply >"$WORK/broken2.log" 2>&1; then
  cat "$WORK/broken2.log"; fail "a failed dump passed"
fi
{ grep -q 'FAIL: mysqldump rift_brain_dev failed' "$WORK/broken2.log" && grep -q 'dropped rj_scrub_broken' "$WORK/broken2.log"; } \
  || { cat "$WORK/broken2.log"; fail "the failed dump's report"; }
! db_exists rj_scrub_broken || fail "a failed dump left rj_scrub_broken behind"
[ -z "$(ls -A "$WORK/tmp")" ] || fail "a failed dump left its file: $(ls -A "$WORK/tmp")"
pass "a copy that fails part way is dropped: its scrub failing (a trigger), or its dump (and the dump file with it)"

# --- a scrubbed copy ----------------------------------------------------------------------------------------------
[ "$(db_sum rift_brain_dev)" = "$DEV_SUM" ] || fail "rift_brain_dev changed before the copy"
scrub dev rj_scrub_snap --apply >"$WORK/snap.log" 2>&1 || { cat "$WORK/snap.log"; fail "copy and scrub"; }
grep -q '4 users, 4 not yet scrubbed; 2 device credentials; 0 legacy access tokens; 3 feedback entries' "$WORK/snap.log" \
  || { cat "$WORK/snap.log"; fail "the copy's counts"; }
grep -q 'anon_pending\|WARNING' "$WORK/snap.log" && { cat "$WORK/snap.log"; fail "a copy's feedback is not this run's to keep: no refusal, no warning"; }
[ -z "$(leaks rj_scrub_snap)" ] || fail "the copy still holds player details in: $(leaks rj_scrub_snap | tr '\n' ' ')"
[ "$(sql -e 'SELECT (SELECT COUNT(*) FROM rj_scrub_snap.feedback) + (SELECT COUNT(*) FROM rj_scrub_snap.user_credentials)')" = 0 ] \
  || fail "the copy's feedback or user_credentials is not empty"
[ "$(sql -e "SELECT COUNT(*) FROM rj_scrub_snap.users WHERE username = CONCAT('user', user_id) AND email = CONCAT('user', user_id, '@example.invalid')")" = 4 ] \
  || fail "the copy's users: $(sql -e 'SELECT user_id, username, email FROM rj_scrub_snap.users')"
[ "$(kept_sum rj_scrub_snap)" = "$(kept_sum rift_brain_dev)" ] || fail "the copy's kept tables differ from dev's"
[ "$(db_sum rift_brain_dev)" = "$DEV_SUM" ] || fail "copying changed rift_brain_dev"
pass "dev -> a new database: no player detail in any column, feedback and credentials empty, kept tables as dev's; dev untouched"

# --- in place -----------------------------------------------------------------------------------------------------
for flag in "" --apply; do
  if scrub dev rift_brain_dev ${flag:+"$flag"} >"$WORK/anon.log" 2>&1; then
    cat "$WORK/anon.log"; fail "in place, ${flag:-PLAN} went ahead past an anon_pending row"
  fi
  grep -q 'FAIL: 1 feedback entries are anon_pending' "$WORK/anon.log" || { cat "$WORK/anon.log"; fail "the ${flag:-PLAN} refusal"; }
done
[ "$(db_sum rift_brain_dev)" = "$DEV_SUM" ] || fail "the anon_pending refusal changed rift_brain_dev"
pass "in place, an anon_pending feedback row refuses PLAN and --apply, changing nothing"

sql rift_brain_dev -e "UPDATE feedback SET sheet_state = 'done_anon' WHERE sheet_state = 'anon_pending'"
DEV_SUM="$(db_sum rift_brain_dev)"
KEPT_BEFORE="$(kept_sum rift_brain_dev)"
scrub dev rift_brain_dev >"$WORK/plan.log" 2>&1 || { cat "$WORK/plan.log"; fail "in-place PLAN"; }
grep -q 'WARNING: 1 feedback entries are not on the sheet yet (pending)' "$WORK/plan.log" || { cat "$WORK/plan.log"; fail "no pending warning"; }
grep -q 'PLAN: rewrite email, username and password of 4 users; delete 2 credentials; clear 0 access tokens; delete 3 feedback entries' "$WORK/plan.log" \
  || { cat "$WORK/plan.log"; fail "the PLAN line"; }
grep -q "kept as they are (no personal data): ${KEPT// /, }" "$WORK/plan.log" || { cat "$WORK/plan.log"; fail "the kept tables line"; }
[ "$(db_sum rift_brain_dev)" = "$DEV_SUM" ] || fail "the PLAN changed rift_brain_dev"
pass "in-place PLAN: names 4 users, 2 credentials, 3 feedback entries and the 5 kept tables, warns of the 1 unsent, changes nothing"

scrub dev rift_brain_dev --apply >"$WORK/apply.log" 2>&1 || { cat "$WORK/apply.log"; fail "in-place --apply"; }
[ -z "$(leaks rift_brain_dev)" ] || fail "dev still holds player details in: $(leaks rift_brain_dev | tr '\n' ' ')"
[ "$(sql -e 'SELECT (SELECT COUNT(*) FROM rift_brain_dev.feedback) + (SELECT COUNT(*) FROM rift_brain_dev.user_credentials)')" = 0 ] \
  || fail "dev's feedback or user_credentials is not empty"
[ "$(kept_sum rift_brain_dev)" = "$KEPT_BEFORE" ] || fail "the scrub changed a kept table"
pass "in place: no player detail in any column of any table; feedback and credentials empty; the 5 kept tables unchanged"

SCRUBBED_SUM="$(db_sum rift_brain_dev)"
scrub dev rift_brain_dev --apply >"$WORK/again.log" 2>&1 || { cat "$WORK/again.log"; fail "re-run"; }
grep -q '4 users, 0 not yet scrubbed; 0 device credentials; 0 legacy access tokens; 0 feedback entries' "$WORK/again.log" \
  || { cat "$WORK/again.log"; fail "the re-run found work"; }
[ "$(db_sum rift_brain_dev)" = "$SCRUBBED_SUM" ] || fail "a re-run changed dev"
pass "a re-run finds nothing to do and changes nothing"

# The brain's own feedback code on the scrubbed table: the forwarder has nothing to send or rewrite, and a new
# entry is stored as it would be on dev.
(cd "$REPO_DIR" && RJ_PORT="$PORT" RJ_PW="$PW" node -e "
  const { initDB, getDB } = require('./src/db');
  initDB({ host: '127.0.0.1', port: Number(process.env.RJ_PORT), user: 'root', password: process.env.RJ_PW, database: 'rift_brain_dev' });
  const fb = require('./src/storage/feedback');
  (async () => {
    const store = fb.createFeedbackSheetStore();
    const now = Date.now();
    const append = await store.dueForAppend(20, now);
    const anon = await store.dueForAnonymize(20, now);
    const sent = await store.sentSince(now - 86400000);
    const row = { id: '44444444-4444-4444-8444-444444444444', received_ms: now, written_at: null, user_id: 2,
      username: 'user2', install_id: null, build: 1, platform: 'android', env: 'dev', tags: [], message: 'after', context: {} };
    const ins = await fb.insertFeedback(row);
    const due = await store.dueForAppend(20, now + 1000);
    await getDB().end();
    if (append.length || anon.length || sent !== 0 || ins.duplicate || due.length !== 1) {
      console.error({ append, anon, sent, ins, due }); process.exit(1);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
") || fail "src/storage/feedback on the scrubbed table"
pass "src/storage/feedback on the scrubbed dev: nothing due for the sheet, none sent today, and a new entry stores and is due"

echo "scrub_snapshot: $PASSES passed"
