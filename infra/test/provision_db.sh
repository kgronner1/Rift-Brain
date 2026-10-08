#!/usr/bin/env bash
# Runs infra/box/provision.sh's .env and database steps against MariaDB 10.11 in Docker, as the box would:
# a "rift_brain" built from migrations/0001_baseline.sql with two users in it stands in for the live database.
#
#   bash infra/test/provision_db.sh
#
# Grades: PLAN changes nothing; dev is a dump-and-load copy, baselined and migrated, with its own user granted on
# it alone; rift_brain is untouched; a second --apply changes nothing; an .env from before M4 gains only the settings
# it lacks; --recopy-db starts dev over; alpha is built fresh. Needs Docker; the container (rj-provision-test-<pid>) is removed on every exit path.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${MARIADB_IMAGE:-mariadb:10.11}"
NAME="rj-provision-test-$$"
PW="rjtest$(openssl rand -hex 8)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-provision-test.XXXXXX")"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PASSES=0
pass() { echo "PASS $*"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*"; exit 1; }

docker run -d --name "$NAME" -e MARIADB_ROOT_PASSWORD="$PW" -p 127.0.0.1::3306 "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 3306/tcp | head -n 1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  docker exec "$NAME" mariadb -uroot -p"$PW" -e 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
sql() { docker exec -i "$NAME" mariadb -uroot -p"$PW" --batch --skip-column-names "$@"; }

# The legacy database: the real baseline, two users.
sql -e 'CREATE DATABASE rift_brain'
sql rift_brain <"$REPO_DIR/migrations/0001_baseline.sql"
sql rift_brain -e "INSERT INTO users (username, email, password, access_token) VALUES ('ann','ann@x.test','h1','t1'), ('bob','bob@x.test','h2','t2')"
LEGACY_BEFORE="$(sql -e "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='rift_brain' ORDER BY 1,2" | shasum)"

# A brain checkout as provision.sh expects one: src, migrations, node_modules.
make_brain() {
  local dir="$WORK/rj/$1/brain"
  mkdir -p "$dir"
  cp -R "$REPO_DIR/src" "$REPO_DIR/migrations" "$REPO_DIR/package.json" "$dir/"
  ln -s "$REPO_DIR/node_modules" "$dir/node_modules"
}
make_brain dev
make_brain alpha

provision() {
  RJ_ROOT="$WORK/rj" RJ_PROVISION_STEPS="dotenv database" RJ_MYSQL_PORT="$PORT" RJ_DB_USER_HOSTS="%" \
    RJ_MYSQL_ADMIN="docker exec -i $NAME mariadb -uroot -p$PW" \
    RJ_MYSQLDUMP_ADMIN="docker exec -i $NAME mariadb-dump -uroot -p$PW" \
    bash "$REPO_DIR/infra/box/provision.sh" --ref test "$@"
}

# --- PLAN --------------------------------------------------------------------------------------------------------
provision --env dev >"$WORK/plan.log" 2>&1 || { cat "$WORK/plan.log"; fail "plan run"; }
grep -q 'PLAN: mysqldump rift_brain | mysql rift_brain_dev' "$WORK/plan.log" || { cat "$WORK/plan.log"; fail "plan names the copy"; }
[ ! -f "$WORK/rj/dev/brain/.env" ] || fail "plan wrote .env"
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='rift_brain_dev'")" = 0 ] || fail "plan created the database"
pass "PLAN changes nothing (no .env, no database)"

# --- dev, first apply --------------------------------------------------------------------------------------------
provision --env dev --apply >"$WORK/apply1.log" 2>&1 || { cat "$WORK/apply1.log"; fail "dev apply"; }
ENVF="$WORK/rj/dev/brain/.env"
[ -n "$(find "$ENVF" -perm 600)" ] || fail ".env is not chmod 600"
for k in SESSION_KEY JOIN_KEY LOBBY_MASTER_KEY; do
  grep -qE "^$k=[0-9a-f]{64}\$" "$ENVF" || fail ".env has no 32-byte $k"
done
(cd "$WORK/rj/dev/brain" && node -e "require('dotenv').config(); require('./src/config/env').loadEnv(process.env)") \
  || fail ".env does not pass the brain's own loadEnv"
pass ".env: chmod 600, three 32-byte keys, accepted by src/config/env.js"

[ "$(sql -e 'SELECT COUNT(*) FROM rift_brain_dev.users')" = 2 ] || fail "dev has not the copied users"
[ "$(sql -e "SELECT GROUP_CONCAT(version ORDER BY version), GROUP_CONCAT(baseline ORDER BY version) FROM rift_brain_dev.schema_migrations")" = $'1,2\t1,0' ] \
  || fail "dev migrations: $(sql -e 'SELECT version, baseline FROM rift_brain_dev.schema_migrations')"
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='rift_brain_dev' AND TABLE_NAME='users' AND COLUMN_NAME='access_token'")" = 0 ] \
  || fail "dev still has users.access_token"
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='rift_brain_dev' AND TABLE_NAME='user_credentials'")" = 1 ] \
  || fail "dev has no user_credentials"
pass "dev: a copy of rift_brain's 2 users, 0001 baselined, 0002 applied"

[ "$(sql -e "SELECT DISTINCT TABLE_SCHEMA FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES WHERE GRANTEE LIKE '''rift_brain_dev''@%'")" = rift_brain_dev ] \
  || fail "rift_brain_dev's grants: $(sql -e "SHOW GRANTS FOR 'rift_brain_dev'@'%'")"
DEVPW="$(sed -n 's/^MYSQL_PASSWORD=//p' "$ENVF")"
docker exec "$NAME" mariadb -urift_brain_dev -p"$DEVPW" -h 127.0.0.1 rift_brain -e 'SELECT 1' >/dev/null 2>&1 \
  && fail "rift_brain_dev can read rift_brain"
docker exec "$NAME" mariadb -urift_brain_dev -p"$DEVPW" -h 127.0.0.1 rift_brain_dev -e 'SELECT COUNT(*) FROM users' >/dev/null \
  || fail "rift_brain_dev cannot read its own database with the .env password"
pass "user rift_brain_dev: its own database only, with the password in .env"

[ "$(sql -e "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='rift_brain' ORDER BY 1,2" | shasum)" = "$LEGACY_BEFORE" ] \
  || fail "rift_brain's schema changed"
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='rift_brain' AND TABLE_NAME='schema_migrations'")" = 0 ] \
  || fail "rift_brain got a schema_migrations table"
[ "$(sql -e "SELECT GROUP_CONCAT(access_token ORDER BY user_id) FROM rift_brain.users")" = "t1,t2" ] || fail "rift_brain's rows changed"
pass "rift_brain untouched (schema, rows, no schema_migrations)"

# --- dev, second apply: nothing to do ----------------------------------------------------------------------------
KEYS_BEFORE="$(shasum <"$ENVF")"
provision --env dev --apply >"$WORK/apply2.log" 2>&1 || { cat "$WORK/apply2.log"; fail "dev re-apply"; }
grep -q 'already holds a copy; not copied again' "$WORK/apply2.log" || { cat "$WORK/apply2.log"; fail "re-apply copied again"; }
grep -q 'rift_brain_dev is up to date' "$WORK/apply2.log" || { cat "$WORK/apply2.log"; fail "re-apply migrated"; }
[ "$(shasum <"$ENVF")" = "$KEYS_BEFORE" ] || fail "re-apply rewrote .env"
pass "a second --apply changes nothing (.env kept, no copy, migrations up to date)"

# --- dev, an .env from before M4 (RJ 466): only the missing settings are appended --------------------------------
grep -vE '^(JOIN_KEY|LOBBY_MASTER_KEY|INTERNAL_PORT)=' "$ENVF" >"$WORK/old.env"
cp "$WORK/old.env" "$ENVF"
OLD_SUM="$(shasum <"$ENVF")"
provision --env dev >"$WORK/plan-m4.log" 2>&1 || { cat "$WORK/plan-m4.log"; fail "plan over an old .env"; }
grep -q 'PLAN: append to .* the M4 settings it lacks: INTERNAL_PORT JOIN_KEY LOBBY_MASTER_KEY' "$WORK/plan-m4.log" \
  || { cat "$WORK/plan-m4.log"; fail "plan does not name the M4 settings to append"; }
[ "$(shasum <"$ENVF")" = "$OLD_SUM" ] || fail "plan changed an old .env"
provision --env dev --apply >"$WORK/apply-m4.log" 2>&1 || { cat "$WORK/apply-m4.log"; fail "apply over an old .env"; }
[ "$(head -n "$(wc -l <"$WORK/old.env")" "$ENVF" | shasum)" = "$OLD_SUM" ] || fail "an existing .env line changed"
grep -qx 'INTERNAL_PORT=3101' "$ENVF" || fail "INTERNAL_PORT was not appended"
for k in JOIN_KEY LOBBY_MASTER_KEY; do
  grep -qE "^$k=[0-9a-f]{64}\$" "$ENVF" || fail "$k was not appended"
done
(cd "$WORK/rj/dev/brain" && node -e "require('dotenv').config(); require('./src/config/env').loadEnv(process.env)") \
  || fail "the appended .env does not pass loadEnv"
KEYS_BEFORE="$(shasum <"$ENVF")"
provision --env dev --apply >"$WORK/apply-m4b.log" 2>&1 || { cat "$WORK/apply-m4b.log"; fail "re-apply after the M4 append"; }
[ "$(shasum <"$ENVF")" = "$KEYS_BEFORE" ] || fail "a second apply appended again"
pass "an .env from before M4: PLAN names what it lacks and changes nothing; --apply appends only that; then nothing"

# --- dev, --recopy-db --------------------------------------------------------------------------------------------
sql rift_brain -e "INSERT INTO users (username, email, password, access_token) VALUES ('cat','cat@x.test','h3','t3')"
provision --env dev --apply --recopy-db >"$WORK/recopy.log" 2>&1 || { cat "$WORK/recopy.log"; fail "recopy"; }
[ "$(sql -e 'SELECT COUNT(*) FROM rift_brain_dev.users')" = 3 ] || fail "recopy did not take the new row"
[ "$(sql -e "SELECT GROUP_CONCAT(version ORDER BY version) FROM rift_brain_dev.schema_migrations")" = 1,2 ] || fail "recopy migrations"
pass "--recopy-db: a fresh copy (3 users), baselined and migrated again"

# --- alpha: fresh from migrations ---------------------------------------------------------------------------------
provision --env alpha --recopy-db >/dev/null 2>&1 && fail "--recopy-db was accepted for alpha"
provision --env alpha --apply >"$WORK/alpha.log" 2>&1 || { cat "$WORK/alpha.log"; fail "alpha apply"; }
[ "$(sql -e 'SELECT COUNT(*) FROM rift_brain_alpha.users')" = 0 ] || fail "alpha is not empty"
[ "$(sql -e "SELECT GROUP_CONCAT(version ORDER BY version), GROUP_CONCAT(baseline ORDER BY version) FROM rift_brain_alpha.schema_migrations")" = $'1,2\t0,0' ] \
  || fail "alpha migrations"
[ "$(sql -e "SELECT DISTINCT TABLE_SCHEMA FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES WHERE GRANTEE LIKE '''rift_brain_alpha''@%'")" = rift_brain_alpha ] \
  || fail "alpha grants"
for line in PUBLIC_PORT=3002 GAME_PORTS=8090-8099; do
  grep -qx "$line" "$WORK/rj/alpha/brain/.env" || fail "alpha .env has no $line"
done
pass "alpha: built fresh from 0001 + 0002, its own user, ports 3002 / 8090-8099"

echo "provision_db: $PASSES passed"
