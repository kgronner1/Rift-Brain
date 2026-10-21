#!/usr/bin/env bash
# Scrubs a snapshot of player data so it can live outside production (RJ 469, spec M7; every table, RJ 511). The data
# rule: README.md, "Player data outside production".
#
#   bash ops/db/scrub_snapshot.sh <source env> <target db>            PLAN: read-only; prints what --apply would do
#   bash ops/db/scrub_snapshot.sh <source env> <target db> --apply    do it
#   bash ops/db/scrub_snapshot.sh <source env> <target db> --box ...  the same, run on the box over SSH (like
#                                                                     infra/provision_box.sh; reads deploy.env)
#
#   <source env>   where the data came from: legacy (the database rift_brain) or dev (rift_brain_dev)
#   <target db>    the database to scrub. When it is the source's own database (dev rift_brain_dev) it is scrubbed
#                  in place. Otherwise, if it does not exist, it is first made as a copy of the source (mysqldump,
#                  the source is only read); if it exists it is scrubbed as it stands, never copied over.
#
# What --apply does to <target db>, in one transaction, table by table ("Every table" below names them all):
#   users              email = user<id>@example.invalid, username = user<id>, password = one fixed bcrypt hash of
#                      the dev password printed at the end (the login code still works), access_token = NULL where
#                      the column still exists (a copy not yet migrated past 0001)
#   user_credentials   every row deleted: no device credential, and no install id, outlives the scrub
#   feedback           every row deleted: each holds a sender's username and install id, text a player typed, and
#                      their device's details. Dev needs no other environment's feedback, and the forwarder can
#                      never send a copied row to the sheet when there is none
#   the rest           kept as they are: stats, accolades, the player card and schema_migrations hold numbers and
#                      times only (and the string columns KEEP_STRINGS names), keyed by a user_id made anonymous above
# Safe to re-run: a scrubbed database scrubs to itself.
#
# Before anything is copied or changed, PLAN included, the database is checked against "Every table": a table it
# does not name, a users column it does not name, or a string column in a kept table that KEEP_STRINGS does not name
# fails the scrub. So a table or column a later migration adds stops the scrub until someone says how to scrub it.
# A copy this run made is dropped if anything after it fails: unscrubbed data never outlives a failed run.
#
# Refuses: a target whose name contains "alpha" or "prod" (any case), the legacy database rift_brain itself, and any
# name that is not [A-Za-z0-9_]. Alpha and production data is never scrubbed, because it never leaves its database.
# In place, it also refuses while a feedback row is anon_pending: the sheet still names an account deleted since,
# until the forwarder rewrites that row's Player cell, and a deleted row never would be.
#
# The MariaDB admin connection is "sudo mysql" (unix socket root) as in infra/box/provision.sh, unless
# RJ_MYSQL_ADMIN / RJ_MYSQLDUMP_ADMIN name another.
set -euo pipefail

LEGACY_DB=rift_brain
# bcrypt (cost 10) of DEV_PASSWORD. Public on purpose: the repository is public, and a scrubbed database holds
# no account worth protecting.
DEV_PASSWORD='riftjumpers-dev'
# shellcheck disable=SC2016 # a bcrypt hash, not an expansion
DEV_HASH='$2b$10$HSHyJmHlrYq1975Uw.uPwegf10x2dJ2M7oJ.HArYmWSr2DcT90KHq'

# --- Every table -------------------------------------------------------------------------------------------------
# Every table a Rift-Brain database holds (migrations/ makes them, and src/migrate.js makes schema_migrations), by
# what the scrub does to it. A new table goes in one of the lists, with the header above saying why; a new users
# column goes in USERS_COLUMNS once the users step scrubs it, or needs no scrub.
EMPTY_TABLES="user_credentials feedback"
KEEP_TABLES="user_stats user_accolades user_accolades_time_earned user_player_card schema_migrations"
USERS_COLUMNS="user_id username email password access_token is_guest last_login created_date"
# The only columns of a kept table that may hold anything but a number or a time.
KEEP_STRINGS="user_player_card.equipped_accolade_key schema_migrations.name schema_migrations.checksum"
NUMBERS_AND_TIMES="'tinyint','smallint','mediumint','int','bigint','decimal','float','double','bit','year','date','time','datetime','timestamp'"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d'; }

SOURCE_ENV=""
TARGET=""
APPLY=0
BOX=0
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; PASS+=(--apply); shift ;;
    --box) BOX=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "scrub_snapshot.sh: unknown option $1 (--help)" >&2; exit 2 ;;
    *)
      if [ -z "$SOURCE_ENV" ]; then SOURCE_ENV="$1"
      elif [ -z "$TARGET" ]; then TARGET="$1"
      else echo "scrub_snapshot.sh: too many arguments (--help)" >&2; exit 2; fi
      shift ;;
  esac
done

die() { echo "[scrub $TARGET] FAIL: $*" >&2; exit 1; }
say() { echo "[scrub $TARGET] $*"; }
plan() { echo "[scrub $TARGET] PLAN: $*"; }

[ -n "$SOURCE_ENV" ] && [ -n "$TARGET" ] || { echo "usage: scrub_snapshot.sh <source env> <target db> [--apply] [--box]" >&2; exit 2; }
case "$SOURCE_ENV" in
  legacy) SOURCE_DB="$LEGACY_DB" ;;
  dev) SOURCE_DB=rift_brain_dev ;;
  *) echo "scrub_snapshot.sh: <source env> is legacy or dev, not $SOURCE_ENV" >&2; exit 2 ;;
esac

# The refusals come first, before any connection, so a wrong name can never reach a database.
[[ "$TARGET" =~ ^[A-Za-z0-9_]+$ ]] || die "the target name must be [A-Za-z0-9_] only"
lower="$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]')"
case "$lower" in
  *alpha*|*prod*) die "refusing $TARGET: alpha and production data is never scrubbed (README.md, \"Player data outside production\")" ;;
esac
[ "$lower" != "$LEGACY_DB" ] || die "refusing $LEGACY_DB: the legacy brain's live database is never scrubbed"

if [ "$BOX" = 1 ]; then
  DEPLOY_ENV="${RJ_DEPLOY_ENV_FILE:-$HOME/.config/rift-jumpers/deploy.env}"
  [ -f "$DEPLOY_ENV" ] || die "no $DEPLOY_ENV (RJ_DEPLOY_PEM, RJ_DEPLOY_HOST)"
  # shellcheck source=/dev/null
  . "$DEPLOY_ENV"
  [ -n "${RJ_DEPLOY_PEM:-}" ] && [ -n "${RJ_DEPLOY_HOST:-}" ] || die "$DEPLOY_ENV must set RJ_DEPLOY_PEM and RJ_DEPLOY_HOST"
  echo "[scrub_snapshot] $SOURCE_ENV -> $TARGET on $RJ_DEPLOY_HOST ($([ "$APPLY" = 1 ] && echo apply || echo plan))"
  exec ssh -i "$RJ_DEPLOY_PEM" -o ConnectTimeout=15 "$RJ_DEPLOY_HOST" \
    "bash -s -- $SOURCE_ENV $TARGET ${PASS[*]:-}" <"$0"
fi

read -r -a MYSQL_ADMIN <<<"${RJ_MYSQL_ADMIN:-sudo mysql}"
read -r -a MYSQLDUMP_ADMIN <<<"${RJ_MYSQLDUMP_ADMIN:-sudo mysqldump}"
# </dev/null: under --box this script arrives on bash's stdin, which nothing it runs may read.
admin_sql() { "${MYSQL_ADMIN[@]}" --batch --skip-column-names -e "$1" </dev/null; }
db_exists() { [ "$(admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$1'")" = 1 ]; }
has_table() { [ "$(admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$1' AND TABLE_NAME='$2'")" = 1 ]; }
has_column() {
  [ "$(admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='$1' AND TABLE_NAME='$2' AND COLUMN_NAME='$3'")" = 1 ]
}
in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }
sql_list() { local out="" w; for w in $1; do out="$out${out:+,}'$w'"; done; printf '%s' "$out"; }

# Fails, naming each, on anything in <db> that "Every table" does not cover. Reads only.
check_known() {
  local db="$1" unknown="" tables cols strings name
  tables="$(admin_sql "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$db' ORDER BY 1")"
  cols="$(admin_sql "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='$db' AND TABLE_NAME='users' ORDER BY ORDINAL_POSITION")"
  strings="$(admin_sql "SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='$db'
                        AND TABLE_NAME IN ($(sql_list "$KEEP_TABLES")) AND DATA_TYPE NOT IN ($NUMBERS_AND_TIMES) ORDER BY 1")"
  while IFS= read -r name; do
    [ -z "$name" ] || [ "$name" = users ] || in_list "$name" "$EMPTY_TABLES $KEEP_TABLES" || unknown="$unknown table $name,"
  done <<<"$tables"
  while IFS= read -r name; do
    [ -z "$name" ] || in_list "$name" "$USERS_COLUMNS" || unknown="$unknown column users.$name,"
  done <<<"$cols"
  while IFS= read -r name; do
    [ -z "$name" ] || in_list "$name" "$KEEP_STRINGS" || unknown="$unknown column $name,"
  done <<<"$strings"
  [ -z "$unknown" ] || die "$db holds what this script does not know how to scrub:${unknown%,}. \
Name each in ops/db/scrub_snapshot.sh (\"Every table\") with what the scrub does to it. The scrub changed nothing"
  say "$db: every table and column is one the scrub knows"
}

COPY_MADE=0
FINISHED=0
DUMP=""
on_exit() {
  [ -z "$DUMP" ] || rm -f "$DUMP"
  [ "$COPY_MADE" = 1 ] && [ "$FINISHED" = 0 ] || return 0
  if admin_sql "DROP DATABASE IF EXISTS \`$TARGET\`"; then
    echo "[scrub $TARGET] dropped $TARGET, the copy this run made: unscrubbed data never outlives a failed run" >&2
  else
    echo "[scrub $TARGET] FAIL: could not drop $TARGET, the unscrubbed copy this run made; drop it by hand" >&2
  fi
}
trap on_exit EXIT

if [ "$APPLY" = 1 ]; then say "APPLY ($SOURCE_ENV data)"; else say "PLAN only: read-only; nothing changes"; fi
admin_sql 'SELECT 1' >/dev/null 2>&1 || die "cannot reach MariaDB as admin with: ${MYSQL_ADMIN[*]} (set RJ_MYSQL_ADMIN)"

# --- the copy, when the target is not the source's own database and does not exist yet ---------------------------
if [ "$TARGET" != "$SOURCE_DB" ] && ! db_exists "$TARGET"; then
  db_exists "$SOURCE_DB" || die "neither $TARGET nor the source $SOURCE_DB exists"
  check_known "$SOURCE_DB"
  if [ "$APPLY" = 0 ]; then
    plan "CREATE DATABASE $TARGET; mysqldump $SOURCE_DB | mysql $TARGET ($SOURCE_DB is only read); then scrub it"
    say "done (plan only)"
    exit 0
  fi
  say "copying $SOURCE_DB into $TARGET (mysqldump --single-transaction; $SOURCE_DB is only read)"
  admin_sql "CREATE DATABASE \`$TARGET\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  COPY_MADE=1
  DUMP="$(umask 077 && mktemp "${TMPDIR:-/tmp}/rj-scrub-$TARGET.XXXXXX")"
  "${MYSQLDUMP_ADMIN[@]}" --single-transaction --routines --triggers --events --hex-blob "$SOURCE_DB" >"$DUMP" </dev/null \
    || die "mysqldump $SOURCE_DB failed"
  "${MYSQL_ADMIN[@]}" "$TARGET" <"$DUMP" || die "loading the copy of $SOURCE_DB into $TARGET failed"
  rm -f "$DUMP"
  DUMP=""
  say "copied: $(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users") users"
elif [ "$TARGET" != "$SOURCE_DB" ]; then
  say "$TARGET exists; scrubbed as it stands (not copied from $SOURCE_DB again)"
else
  db_exists "$TARGET" || die "$TARGET does not exist"
fi

has_table "$TARGET" users || die "$TARGET has no users table; is it a Rift-Brain database?"
check_known "$TARGET"

# --- what is there now ------------------------------------------------------------------------------------------
USERS="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users")"
DIRTY="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE email <> CONCAT('user', user_id, '@example.invalid')
                    OR username <> CONCAT('user', user_id) OR password <> '$DEV_HASH'")"
CREDS=0
has_table "$TARGET" user_credentials && CREDS="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.user_credentials")"
TOKENS=0
has_column "$TARGET" users access_token \
  && TOKENS="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE access_token IS NOT NULL")"
FEEDBACK=0
UNSENT=0
ANON_PENDING=0
if has_table "$TARGET" feedback; then
  FEEDBACK="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.feedback")"
  UNSENT="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.feedback WHERE sheet_state = 'pending'")"
  ANON_PENDING="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.feedback WHERE sheet_state = 'anon_pending'")"
fi
say "$USERS users, $DIRTY not yet scrubbed; $CREDS device credentials; $TOKENS legacy access tokens; $FEEDBACK feedback entries"
KEPT=""
for t in $KEEP_TABLES; do
  if has_table "$TARGET" "$t"; then KEPT="$KEPT${KEPT:+, }$t"; fi
done
say "kept as they are (no personal data): ${KEPT:-none}"

# In place, the feedback is this environment's own, and its forwarder has the only copy of what it has not sent.
if [ "$TARGET" = "$SOURCE_DB" ]; then
  [ "$ANON_PENDING" = 0 ] || die "$ANON_PENDING feedback entries are anon_pending: the Player Feedback sheet still \
names an account deleted since, until $TARGET's forwarder rewrites their Player cell (every 30 s). Scrub once \
'SELECT sheet_state, COUNT(*) FROM feedback GROUP BY sheet_state' shows none. The scrub changed nothing"
  [ "$UNSENT" = 0 ] || say "WARNING: $UNSENT feedback entries are not on the sheet yet (pending); --apply deletes them too"
fi

if [ "$APPLY" = 0 ]; then
  plan "rewrite email, username and password of $DIRTY users; delete $CREDS credentials; clear $TOKENS access tokens; delete $FEEDBACK feedback entries"
  say "done (plan only)"
  exit 0
fi

# Two passes, so the unique keys on username and email never see a collision part way through: a real player
# named "user7" who is not user 7 holds that name only until the first pass moves everyone aside.
SQL="START TRANSACTION;
UPDATE users SET username = CONCAT('~scrub~', user_id), email = CONCAT('~scrub~', user_id, '@example.invalid');
UPDATE users SET username = CONCAT('user', user_id), email = CONCAT('user', user_id, '@example.invalid'),
                 password = '$DEV_HASH';"
if has_column "$TARGET" users access_token; then SQL="$SQL
UPDATE users SET access_token = NULL;"; fi
for t in $EMPTY_TABLES; do
  if has_table "$TARGET" "$t"; then SQL="$SQL
DELETE FROM \`$t\`;"; fi
done
SQL="$SQL
COMMIT;"
"${MYSQL_ADMIN[@]}" "$TARGET" -e "$SQL" </dev/null

# --- check it took ----------------------------------------------------------------------------------------------
left="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE email <> CONCAT('user', user_id, '@example.invalid')
                   OR username <> CONCAT('user', user_id) OR password <> '$DEV_HASH'")"
[ "$left" = 0 ] || die "$left users are still not scrubbed"
for t in $EMPTY_TABLES; do
  if has_table "$TARGET" "$t"; then
    [ "$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.\`$t\`")" = 0 ] || die "$t is not empty"
  fi
done
if has_column "$TARGET" users access_token; then
  [ "$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE access_token IS NOT NULL")" = 0 ] || die "access tokens remain"
fi
FINISHED=1
say "PASS $USERS users scrubbed; no credentials, feedback or access tokens left"
say "every account in $TARGET now signs in as user<id> (or user<id>@example.invalid) with the password: $DEV_PASSWORD"
say "done (applied)"
