#!/usr/bin/env bash
# Scrubs a snapshot of player data so it can live outside production (RJ 469, spec M7). The data rule: README.md,
# "Player data outside production".
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
# What --apply does to <target db>, in one transaction:
#   users.email    = user<id>@example.invalid
#   users.username = user<id>
#   users.password = one fixed bcrypt hash, of the dev password printed at the end (the login code still works)
#   users.access_token = NULL, where the column still exists (a copy not yet migrated past 0001)
#   user_credentials: every row deleted (no device credential outlives the scrub)
# Every other table holds no personal data and is left alone. Safe to re-run: a scrubbed database scrubs to itself.
#
# Refuses: a target whose name contains "alpha" or "prod" (any case), the legacy database rift_brain itself, and any
# name that is not [A-Za-z0-9_]. Alpha and production data is never scrubbed, because it never leaves its database.
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

if [ "$APPLY" = 1 ]; then say "APPLY ($SOURCE_ENV data)"; else say "PLAN only: read-only; nothing changes"; fi
admin_sql 'SELECT 1' >/dev/null 2>&1 || die "cannot reach MariaDB as admin with: ${MYSQL_ADMIN[*]} (set RJ_MYSQL_ADMIN)"

# --- the copy, when the target is not the source's own database and does not exist yet ---------------------------
if [ "$TARGET" != "$SOURCE_DB" ] && ! db_exists "$TARGET"; then
  db_exists "$SOURCE_DB" || die "neither $TARGET nor the source $SOURCE_DB exists"
  if [ "$APPLY" = 0 ]; then
    plan "CREATE DATABASE $TARGET; mysqldump $SOURCE_DB | mysql $TARGET ($SOURCE_DB is only read); then scrub it"
    say "done (plan only)"
    exit 0
  fi
  say "copying $SOURCE_DB into $TARGET (mysqldump --single-transaction; $SOURCE_DB is only read)"
  admin_sql "CREATE DATABASE \`$TARGET\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  dump="$(umask 077 && mktemp "${TMPDIR:-/tmp}/rj-scrub-$TARGET.XXXXXX")"
  # A half-made copy is dropped, and so is the dump: unscrubbed data never outlives a failed run.
  if ! "${MYSQLDUMP_ADMIN[@]}" --single-transaction --routines --triggers --events --hex-blob "$SOURCE_DB" >"$dump" </dev/null \
     || ! "${MYSQL_ADMIN[@]}" "$TARGET" <"$dump"; then
    rm -f "$dump"
    admin_sql "DROP DATABASE \`$TARGET\`"
    die "copying $SOURCE_DB failed; dropped the partial $TARGET"
  fi
  rm -f "$dump"
  say "copied: $(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users") users"
elif [ "$TARGET" != "$SOURCE_DB" ]; then
  say "$TARGET exists; scrubbed as it stands (not copied from $SOURCE_DB again)"
else
  db_exists "$TARGET" || die "$TARGET does not exist"
fi

has_table "$TARGET" users || die "$TARGET has no users table; is it a Rift-Brain database?"

# --- what is there now ------------------------------------------------------------------------------------------
USERS="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users")"
DIRTY="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE email <> CONCAT('user', user_id, '@example.invalid')
                    OR username <> CONCAT('user', user_id) OR password <> '$DEV_HASH'")"
CREDS=0
has_table "$TARGET" user_credentials && CREDS="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.user_credentials")"
TOKENS=0
has_column "$TARGET" users access_token \
  && TOKENS="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE access_token IS NOT NULL")"
say "$USERS users, $DIRTY not yet scrubbed; $CREDS device credentials; $TOKENS legacy access tokens"

if [ "$APPLY" = 0 ]; then
  plan "rewrite email, username and password of $DIRTY users; delete $CREDS credentials; clear $TOKENS access tokens"
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
if has_table "$TARGET" user_credentials; then SQL="$SQL
DELETE FROM user_credentials;"; fi
SQL="$SQL
COMMIT;"
"${MYSQL_ADMIN[@]}" "$TARGET" -e "$SQL" </dev/null

# --- check it took ----------------------------------------------------------------------------------------------
left="$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE email <> CONCAT('user', user_id, '@example.invalid')
                   OR username <> CONCAT('user', user_id) OR password <> '$DEV_HASH'")"
[ "$left" = 0 ] || die "$left users are still not scrubbed"
if has_table "$TARGET" user_credentials; then
  [ "$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.user_credentials")" = 0 ] || die "user_credentials is not empty"
fi
if has_column "$TARGET" users access_token; then
  [ "$(admin_sql "SELECT COUNT(*) FROM \`$TARGET\`.users WHERE access_token IS NOT NULL")" = 0 ] || die "access tokens remain"
fi
say "PASS $USERS users scrubbed; no credentials or access tokens left"
say "every account in $TARGET now signs in as user<id> (or user<id>@example.invalid) with the password: $DEV_PASSWORD"
say "done (applied)"
