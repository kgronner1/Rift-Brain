#!/usr/bin/env bash
# Runs infra/box/provision.sh's .env and database steps against MariaDB 10.11 in Docker, as the box would:
# a "rift_brain" built from migrations/0001_baseline.sql with two users in it stands in for the live database.
#
#   bash infra/test/provision_db.sh
#
# Grades: PLAN changes nothing; dev is a dump-and-load copy, baselined and migrated, with its own user granted on
# it alone; rift_brain is untouched; a second --apply changes nothing; an .env from before M4 gains only the settings
# it lacks; --recopy-db starts dev over; alpha is built fresh, with its own .env, keys and a user that can open no
# other database (RJ 469); the memory check warns and never fails; and ops/db/scrub_snapshot.sh (RJ 469) refuses
# alpha / prod / rift_brain before it connects, scrubs dev so the brain's own login takes the printed password, is a
# no-op when re-run, and snapshots rift_brain into a new database without touching it.
# Needs Docker; the container (rj-provision-test-<pid>) is removed on every exit path.
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
    RJ_NODE_BIN="$(command -v node)" \
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

AENV="$WORK/rj/alpha/brain/.env"
for line in ENV=alpha INTERNAL_PORT=3102 MYSQL_DATABASE=rift_brain_alpha MYSQL_USER=rift_brain_alpha \
  CONFIG_URL=https://config.riftjumpers.space/alpha/client.v1.json SERVERS_DIR="$WORK/rj/alpha/servers"; do
  grep -qx "$line" "$AENV" || fail "alpha .env has no $line"
done
[ -n "$(find "$AENV" -perm 600)" ] || fail "alpha .env is not chmod 600"
for k in SESSION_KEY JOIN_KEY LOBBY_MASTER_KEY MYSQL_PASSWORD; do
  [ "$(sed -n "s/^$k=//p" "$AENV")" != "$(sed -n "s/^$k=//p" "$ENVF")" ] || fail "alpha shares dev's $k"
done
(cd "$WORK/rj/alpha/brain" && node -e "require('dotenv').config(); const e = require('./src/config/env').loadEnv(process.env); if (e.ENV !== 'alpha') throw new Error('env ' + e.ENV)") \
  || fail "alpha's .env does not pass loadEnv as alpha"
pass "alpha .env: ENV=alpha, internal 3102, its own config URL, database and servers dir; keys of its own"

ALPHAPW="$(sed -n 's/^MYSQL_PASSWORD=//p' "$AENV")"
docker exec "$NAME" mariadb -urift_brain_alpha -p"$ALPHAPW" -h 127.0.0.1 rift_brain_alpha -e 'SELECT COUNT(*) FROM users' >/dev/null \
  || fail "rift_brain_alpha cannot read its own database with the .env password"
for other in rift_brain rift_brain_dev; do
  docker exec "$NAME" mariadb -urift_brain_alpha -p"$ALPHAPW" -h 127.0.0.1 "$other" -e 'SELECT 1' >/dev/null 2>&1 \
    && fail "rift_brain_alpha can open $other"
done
[ "$(docker exec "$NAME" mariadb -urift_brain_alpha -p"$ALPHAPW" -h 127.0.0.1 --batch --skip-column-names -e 'SHOW DATABASES' | grep -v '^information_schema$')" = rift_brain_alpha ] \
  || fail "rift_brain_alpha sees other databases"
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='rift_brain_alpha' AND TABLE_NAME='user_credentials'")" = 1 ] \
  || fail "alpha has no user_credentials"
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='rift_brain_alpha' AND TABLE_NAME='users' AND COLUMN_NAME='access_token'")" = 0 ] \
  || fail "alpha has users.access_token"
pass "user rift_brain_alpha: opens rift_brain_alpha only (not rift_brain, not rift_brain_dev); schema is 0002's"

KEYS_BEFORE="$(shasum <"$AENV")"
provision --env alpha --apply >"$WORK/alpha2.log" 2>&1 || { cat "$WORK/alpha2.log"; fail "alpha re-apply"; }
grep -q 'rift_brain_alpha is up to date' "$WORK/alpha2.log" || { cat "$WORK/alpha2.log"; fail "alpha re-apply migrated"; }
[ "$(shasum <"$AENV")" = "$KEYS_BEFORE" ] || fail "alpha re-apply rewrote .env"
pass "a second alpha --apply changes nothing"

# --- the memory check: a warning, never a failure ------------------------------------------------------------------
RJ_PROVISION_STEPS=memory RJ_MEM_AVAILABLE_MB=180 bash "$REPO_DIR/infra/box/provision.sh" --env alpha --ref test >"$WORK/mem-low.log" 2>&1 \
  || { cat "$WORK/mem-low.log"; fail "low memory failed the run"; }
grep -q 'WARNING: only 180 MB of memory available (under 250 MB)' "$WORK/mem-low.log" || { cat "$WORK/mem-low.log"; fail "no low-memory warning"; }
RJ_PROVISION_STEPS=memory RJ_MEM_AVAILABLE_MB=400 bash "$REPO_DIR/infra/box/provision.sh" --env alpha --ref test >"$WORK/mem-ok.log" 2>&1 \
  || { cat "$WORK/mem-ok.log"; fail "memory step"; }
grep -q 'memory: .* 400 MB available' "$WORK/mem-ok.log" || { cat "$WORK/mem-ok.log"; fail "memory not reported"; }
grep -q WARNING "$WORK/mem-ok.log" && { cat "$WORK/mem-ok.log"; fail "a warning at 400 MB"; }
pass "memory: 180 MB available warns and still passes; 400 MB does not warn"

# --- ops/db/scrub_snapshot.sh (RJ 469) ------------------------------------------------------------------------------
scrub() {
  RJ_MYSQL_ADMIN="docker exec -i $NAME mariadb -uroot -p$PW" \
    RJ_MYSQLDUMP_ADMIN="docker exec -i $NAME mariadb-dump -uroot -p$PW" \
    bash "$REPO_DIR/ops/db/scrub_snapshot.sh" "$@"
}
legacy_sum() { sql -e "SELECT user_id, username, email, password, access_token FROM rift_brain.users ORDER BY user_id" | shasum; }
LEGACY_ROWS="$(legacy_sum)"
ALPHA_ROWS="$(sql -e "CHECKSUM TABLE rift_brain_alpha.users")"

# A player really named "user1" who is not user 1, and a device credential: the two things a naive scrub trips on.
sql rift_brain_dev -e "INSERT INTO users (username, email, password) VALUES ('user1', 'real@x.test', 'h4')"
DEV_UID4="$(sql -e "SELECT user_id FROM rift_brain_dev.users WHERE username='user1'")"
sql rift_brain_dev -e "INSERT INTO user_credentials (user_id, token_hash, platform, install_id) VALUES (1, REPEAT('a', 64), 'android', 'i1')"

for bad in rift_brain_alpha alpha_copy my_PROD_copy prod rift_brain RIFT_BRAIN 'x;DROP' ''; do
  if scrub dev "$bad" --apply >"$WORK/refuse.log" 2>&1; then cat "$WORK/refuse.log"; fail "scrub accepted the target '$bad'"; fi
  grep -q 'FAIL: \|usage:' "$WORK/refuse.log" || { cat "$WORK/refuse.log"; fail "'$bad' failed, but not by a refusal"; }
  # "N users, ..." is printed only once connected; a refusal must come before any connection.
  grep -q ' users, ' "$WORK/refuse.log" && { cat "$WORK/refuse.log"; fail "the refusal of '$bad' came after reading the database"; }
done
# The positive control for the line above: an accepted target does print it.
if ! { scrub dev rift_brain_dev >"$WORK/control.log" 2>&1 && grep -q ' users, ' "$WORK/control.log"; }; then
  cat "$WORK/control.log"; fail "control: an accepted target's PLAN did not report its users"
fi
scrub prod rift_brain_dev --apply >/dev/null 2>&1 && fail "scrub accepted the source env prod"
[ "$(legacy_sum)" = "$LEGACY_ROWS" ] || fail "a refused scrub changed rift_brain"
[ "$(sql -e "CHECKSUM TABLE rift_brain_alpha.users")" = "$ALPHA_ROWS" ] || fail "a refused scrub changed rift_brain_alpha"
pass "scrub refuses alpha / prod (any case), rift_brain, a bad name and an unknown source env; nothing changed"

DEV_BEFORE="$(sql -e "SELECT * FROM rift_brain_dev.users ORDER BY user_id" | shasum)"
scrub dev rift_brain_dev >"$WORK/scrub-plan.log" 2>&1 || { cat "$WORK/scrub-plan.log"; fail "scrub plan"; }
grep -q 'PLAN: rewrite email, username and password of 4 users; delete 1 credentials' "$WORK/scrub-plan.log" \
  || { cat "$WORK/scrub-plan.log"; fail "scrub plan does not say what it would do"; }
[ "$(sql -e "SELECT * FROM rift_brain_dev.users ORDER BY user_id" | shasum)" = "$DEV_BEFORE" ] || fail "scrub plan changed dev"
pass "scrub PLAN names 4 users and 1 credential, and changes nothing"

scrub dev rift_brain_dev --apply >"$WORK/scrub.log" 2>&1 || { cat "$WORK/scrub.log"; fail "scrub apply"; }
DEVPASS="$(sed -n 's/.*with the password: //p' "$WORK/scrub.log")"
[ -n "$DEVPASS" ] || { cat "$WORK/scrub.log"; fail "scrub did not print the dev password"; }
[ "$(sql -e "SELECT COUNT(*) FROM rift_brain_dev.users WHERE username = CONCAT('user', user_id) AND email = CONCAT('user', user_id, '@example.invalid')")" = 4 ] \
  || fail "dev users: $(sql -e 'SELECT user_id, username, email FROM rift_brain_dev.users')"
[ "$(sql -e "SELECT username FROM rift_brain_dev.users WHERE user_id = $DEV_UID4")" = "user$DEV_UID4" ] || fail "the real 'user1' was not renamed"
[ "$(sql -e 'SELECT COUNT(*) FROM rift_brain_dev.user_credentials')" = 0 ] || fail "user_credentials not emptied"
[ "$(sql -e "SELECT COUNT(*) FROM rift_brain_dev.users WHERE email LIKE '%x.test%'")" = 0 ] || fail "a real email survived"
[ "$(sql -e 'SELECT COUNT(DISTINCT password) FROM rift_brain_dev.users')" = 1 ] || fail "more than one password hash"
pass "scrub: 4 users are user<id> / user<id>@example.invalid, the clash with a real 'user1' resolved; credentials deleted"

# The fixed hash signs in through the brain's own login code, with the password the scrub printed.
(cd "$WORK/rj/dev/brain" && RJ_DEVPASS="$DEVPASS" node -e "
  require('dotenv').config();
  const { initDB, getDB } = require('./src/db');
  const env = require('./src/config/env').loadEnv(process.env);
  initDB({ ...env.MYSQL });
  const users = require('./src/storage/users');
  (async () => {
    const byName = await users.verifyLogin('user2', process.env.RJ_DEVPASS);
    const byEmail = await users.verifyLogin('user3@example.invalid', process.env.RJ_DEVPASS);
    const wrong = await users.verifyLogin('user2', 'not-it');
    await getDB().end();
    if (!byName || byName.user_id !== 2 || !byEmail || byEmail.user_id !== 3 || wrong) { console.error(byName, byEmail, wrong); process.exit(1); }
  })().catch((e) => { console.error(e); process.exit(1); });
") || fail "the scrubbed accounts do not sign in with the printed password through src/storage/users.verifyLogin"
pass "verifyLogin signs user2 (by name) and user3@example.invalid (by email) in with the printed password, and refuses a wrong one"

[ "$(legacy_sum)" = "$LEGACY_ROWS" ] || fail "scrubbing dev changed rift_brain"
DEV_AFTER="$(sql -e "SELECT * FROM rift_brain_dev.users ORDER BY user_id" | shasum)"
scrub dev rift_brain_dev --apply >"$WORK/scrub2.log" 2>&1 || { cat "$WORK/scrub2.log"; fail "scrub re-run"; }
grep -q '4 users, 0 not yet scrubbed; 0 device credentials' "$WORK/scrub2.log" || { cat "$WORK/scrub2.log"; fail "re-run found work"; }
[ "$(sql -e "SELECT * FROM rift_brain_dev.users ORDER BY user_id" | shasum)" = "$DEV_AFTER" ] || fail "a re-run changed dev"
pass "scrub re-run: nothing left to do, dev unchanged; rift_brain untouched"

# A snapshot of the legacy database into a new target: copied, then scrubbed; its access tokens cleared.
scrub legacy rj_snapshot_test >"$WORK/snap-plan.log" 2>&1 || { cat "$WORK/snap-plan.log"; fail "snapshot plan"; }
[ "$(sql -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='rj_snapshot_test'")" = 0 ] || fail "snapshot plan created the database"
scrub legacy rj_snapshot_test --apply >"$WORK/snap.log" 2>&1 || { cat "$WORK/snap.log"; fail "snapshot apply"; }
[ "$(sql -e "SELECT COUNT(*) FROM rj_snapshot_test.users WHERE username = CONCAT('user', user_id) AND access_token IS NULL")" = 3 ] \
  || fail "snapshot: $(sql -e 'SELECT user_id, username, access_token FROM rj_snapshot_test.users')"
[ "$(legacy_sum)" = "$LEGACY_ROWS" ] || fail "the snapshot changed rift_brain"
sql rift_brain -e "INSERT INTO users (username, email, password, access_token) VALUES ('dan','dan@x.test','h5','t5')"
scrub legacy rj_snapshot_test --apply >"$WORK/snap2.log" 2>&1 || { cat "$WORK/snap2.log"; fail "snapshot re-run"; }
grep -q 'exists; scrubbed as it stands' "$WORK/snap2.log" || { cat "$WORK/snap2.log"; fail "snapshot re-run copied again"; }
[ "$(sql -e 'SELECT COUNT(*) FROM rj_snapshot_test.users')" = 3 ] || fail "snapshot re-run took the new legacy row"
pass "scrub legacy -> a new database: copied (rift_brain only read), scrubbed, tokens cleared; a re-run never copies over it"

echo "provision_db: $PASSES passed"
