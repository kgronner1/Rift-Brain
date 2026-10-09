#!/usr/bin/env bash
# Runs drill 5, the stampede, against a local dev brain -- never the real one (RJ 471, spec M9).
#
#   bash ops/drills/test/drill5_local.sh               ~10 min; needs Docker, node_modules (npm ci) and Wobble Planet
#   SWARM_N=100 bash ops/drills/test/drill5_local.sh   a smaller swarm (default 500, the drill's)
#   KEEP=1 bash ops/drills/test/drill5_local.sh        leave the stack up at the end
#   BACKOFF_BASE_MS=4000 bash ops/drills/test/...     dev's document with tunables.backoff.base_ms changed (an experiment)
#
# The stack, all on 127.0.0.1 (the shape of drills_local.sh): MariaDB 10.11 in Docker holding rj_swarm_dev, built by
# migrate; a dev brain with fresh keys, started and stopped through two small scripts that stand in for pm2 (the
# drill's --start-cmd / --stop-cmd); a local HTTPS server standing in for config.riftjumpers.space (the brain's, with a
# throwaway certificate it trusts through NODE_EXTRA_CA_CERTS), into whose directory ops/config/publish.sh --local-root
# publishes, and a plain HTTP server over the same directory for the swarm's --config_url (Godot trusts only real
# certificates). The swarm is Wobble Planet's --net_swarm from RJ_WOBBLE_PLANET (default: the checkout beside this one).
#
# Graded, each a TEST PASS / TEST FAIL line:
#   - swarm_accounts.sql makes the accounts, twice over without duplicates, and refuses rj_swarm_alpha, rj_swarm_test
#     and no database at all, writing nothing
#   - drill 5 in PLAN mode passes and publishes nothing
#   - drill 5 under --run reaches a verdict whose measurement worked: every client signed in, a full steady window, the
#     outage seen by the swarm and measured at about its length, every client back on the brain, no stall; the login
#     limit was raised for the drill and is dev's own again after it; the brain is up. The verdict itself (PASS or
#     FAIL) is printed, not graded: it is what the drill exists to find out
#   - stopped on purpose with the brain down (RJ_DRILL_FAIL_AT=after-stop), the drill fails AND starts the brain again
#     and republishes dev's document; its swarm restored the credentials the first run was issued instead of new ones
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HERE/../../.." && pwd)"
DRILLS="$REPO_DIR/ops/drills"
DB_IMAGE="mariadb:10.11"
SWARM_N="${SWARM_N:-500}"

FAILED=0
tpass() { echo "TEST PASS  $*"; }
tfail() { FAILED=1; echo "TEST FAIL  $*"; }
tdie() { tfail "$*"; exit 1; }
check() { local label="$1"; shift; if "$@"; then tpass "$label"; else tfail "$label"; fi; }
# all <command> [-- <command> ...]: true when every command is (for check, which takes one).
all() {
  local cmd=()
  for a in "$@" --; do
    if [ "$a" = -- ]; then "${cmd[@]}" || return 1; cmd=(); else cmd+=("$a"); fi
  done
}

if ! docker info >/dev/null 2>&1; then echo "drill5_local.sh: Docker is not running"; exit 2; fi
[ -d "$REPO_DIR/node_modules" ] || { echo "drill5_local.sh: run npm ci in $REPO_DIR first"; exit 2; }
WP="${RJ_WOBBLE_PLANET:-$(cd "$REPO_DIR/.." && pwd)/Wobble Planet}"
[ -f "$WP/Scripts/Net/NetSwarm.gd" ] || { echo "drill5_local.sh: no swarm in $WP (set RJ_WOBBLE_PLANET)"; exit 2; }
export RJ_WOBBLE_PLANET="$WP"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/rj-drill5.XXXXXX")"
DB_CONTAINER="rj-drill5-$$"
PIDS=()
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: dev $DEV_API, config $CONFIG_BASE, db container $DB_CONTAINER, files $TMP"
  else
    [ -f "$TMP/brain.pid" ] && kill "$(cat "$TMP/brain.pid")" 2>/dev/null
    [ "${#PIDS[@]}" -gt 0 ] && kill "${PIDS[@]}" 2>/dev/null
    wait 2>/dev/null
    docker rm -f "$DB_CONTAINER" >/dev/null 2>&1
    rm -rf "$TMP"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
wait_log() {  # wait_log <file> <ERE> <seconds>
  for _ in $(seq 1 $(( $3 * 2 ))); do grep -qE -- "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}

# --- the config servers and the document -------------------------------------------------------------------------
ROOT="$TMP/config-root"
mkdir -p "$ROOT"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1 || tdie "openssl could not make a certificate"
CONFIG_PORT="$(free_port)"
PLAIN_PORT="$(free_port)"
cat >"$TMP/serve.py" <<'PY'
import functools, http.server, ssl, sys
port, root, cert, key = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=root))
if cert != "-":
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print("config server up", flush=True)
srv.serve_forever()
PY
python3 -I "$TMP/serve.py" "$CONFIG_PORT" "$ROOT" "$TMP/cert.pem" "$TMP/key.pem" >"$TMP/config.log" 2>&1 &
PIDS+=($!)
python3 -I "$TMP/serve.py" "$PLAIN_PORT" "$ROOT" - - >"$TMP/config_plain.log" 2>&1 &
PIDS+=($!)
wait_log "$TMP/config.log" "config server up" 10 || tdie "the config server did not start"
wait_log "$TMP/config_plain.log" "config server up" 10 || tdie "the plain config server did not start"
CONFIG_BASE="https://127.0.0.1:$CONFIG_PORT"
SWARM_CONFIG_URL="http://127.0.0.1:$PLAIN_PORT/dev/client.v1.json"
export RJ_DRILL_CONFIG_BASE="$CONFIG_BASE" RJ_DRILL_CACERT="$TMP/cert.pem" RJ_DRILL_STATE_DIR="$TMP/state"
DOC=()
if [ -n "${BACKOFF_BASE_MS:-}" ]; then
  node "$DRILLS/drill.mjs" set "$REPO_DIR/config/dev.client.v1.json" tunables.backoff.base_ms "$BACKOFF_BASE_MS" >"$TMP/dev.json"
  DOC=(--file "$TMP/dev.json")
  echo "drill5_local: dev's document with tunables.backoff.base_ms $BACKOFF_BASE_MS"
fi
bash "$REPO_DIR/ops/config/publish.sh" dev ${DOC[@]+"${DOC[@]}"} --local-root "$ROOT" --skip-client-check >"$TMP/publish.log" 2>&1 \
  || { cat "$TMP/publish.log"; tdie "publishing the dev document into the local root"; }
live_serial() { node "$REPO_DIR/ops/config/doc.mjs" serial "$ROOT/dev/client.v1.json"; }
live_limit() { node "$DRILLS/drill.mjs" get "$ROOT/dev/client.v1.json" server.rate_limits.login_per_min_ip; }
ORIG_LIMIT="$(live_limit)"

# --- the database --------------------------------------------------------------------------------------------------
DB_PW="$(openssl rand -hex 12)"
DB_PORT="$(free_port)"
docker run -d --rm --name "$DB_CONTAINER" -e MARIADB_ROOT_PASSWORD="$DB_PW" -e MARIADB_DATABASE=rj_swarm_dev \
  -p "127.0.0.1:$DB_PORT:3306" "$DB_IMAGE" >"$TMP/docker.log" 2>&1 || { cat "$TMP/docker.log"; tdie "docker run"; }
sql() { docker exec -i "$DB_CONTAINER" mariadb -h127.0.0.1 -uroot -p"$DB_PW" -N -B "$@"; }
up=0
for _ in $(seq 1 120); do sql -e 'SELECT 1' >/dev/null 2>&1 && { up=1; break; }; sleep 0.5; done
[ "$up" = 1 ] || tdie "the database never came up"

# --- the brain, and its stand-ins for pm2 stop / start -----------------------------------------------------------------
PUB="$(free_port)"; INTERNAL="$(free_port)"
mkdir -p "$TMP/servers" "$TMP/logs"
echo '{ "servers": [] }' >"$TMP/servers/manifest.json"
BRAIN_ENV=(ENV=dev BIND_HOST=127.0.0.1 PUBLIC_PORT="$PUB" INTERNAL_PORT="$INTERNAL" GAME_HOST=127.0.0.1
  GAME_PORTS="$(( PUB % 1000 + 41000 ))-$(( PUB % 1000 + 41001 ))" SERVERS_DIR="$TMP/servers" SERVER_LOGS_DIR="$TMP/logs"
  SESSION_KEY="$(openssl rand -hex 32)" JOIN_KEY="$(openssl rand -hex 32)" LOBBY_MASTER_KEY="$(openssl rand -hex 32)"
  MYSQL_HOST=127.0.0.1 MYSQL_PORT="$DB_PORT" MYSQL_USER=root MYSQL_PASSWORD="$DB_PW" MYSQL_DATABASE=rj_swarm_dev
  CONFIG_URL="$CONFIG_BASE/dev/client.v1.json" NODE_EXTRA_CA_CERTS="$TMP/cert.pem")
(cd "$REPO_DIR" && env "${BRAIN_ENV[@]}" node src/migrate.js) >"$TMP/migrate.log" 2>&1 || { cat "$TMP/migrate.log"; tdie "migrate"; }
{
  echo '#!/usr/bin/env bash'
  echo "cd $(printf '%q' "$REPO_DIR") || exit 1"
  printf 'env'; printf ' %q' "${BRAIN_ENV[@]}"; echo " node src/app.js >>$(printf '%q' "$TMP/brain.log") 2>&1 &"
  echo "echo \$! >$(printf '%q' "$TMP/brain.pid")"
  echo "for _ in \$(seq 1 40); do [ \"\$(grep -c 'public listener' $(printf '%q' "$TMP/brain.log"))\" -ge \"\$1\" ] && exit 0; sleep 0.5; done"
  echo 'exit 1'
} >"$TMP/brain_start.sh"
cat >"$TMP/brain_stop.sh" <<EOF
#!/usr/bin/env bash
pid="\$(cat "$TMP/brain.pid")"
kill "\$pid" 2>/dev/null
for _ in \$(seq 1 20); do kill -0 "\$pid" 2>/dev/null || exit 0; sleep 0.25; done
kill -9 "\$pid" 2>/dev/null
EOF
STARTS=0
start_brain() { STARTS=$((STARTS + 1)); bash "$TMP/brain_start.sh" "$STARTS"; }
start_brain || { tail -20 "$TMP/brain.log"; tdie "the brain did not start"; }
wait_log "$TMP/brain.log" '\[CONFIG\] serial 1 \(dev\)' 10 || tdie "the brain did not fetch its document"
DEV_API="http://127.0.0.1:$PUB"
tpass "dev brain $DEV_API up on rj_swarm_dev, its document from the local config server"
# The drill's stop and start: each start waits for one more "public listener" line than the log had.
STOP_CMD="bash $(printf '%q' "$TMP/brain_stop.sh")"
START_CMD="bash $(printf '%q' "$TMP/brain_start.sh") \$(( \$(grep -c 'public listener' $(printf '%q' "$TMP/brain.log")) + 1 ))"

# --- the accounts --------------------------------------------------------------------------------------------------
load_accounts() {  # load_accounts <database|-> [count]: the SQL file's output, and its exit status
  local db=() count="${2:-}"
  [ "$1" = - ] || db=("$1")
  { [ -z "$count" ] || echo "SET @swarm_count = $count;"; cat "$DRILLS/swarm_accounts.sql"; } | sql ${db[@]+"${db[@]}"} 2>&1 | grep -vE '^-+$|^$' | tail -n 1
}
out="$(load_accounts rj_swarm_dev "$SWARM_N")"; rc=$?
swarm_users() { sql rj_swarm_dev -e "SELECT COUNT(*) FROM users WHERE username REGEXP '^swarm[0-9]{4}\$'"; }
check "swarm_accounts.sql made $SWARM_N accounts in rj_swarm_dev ($out)" all [ "$rc" = 0 ] -- [ "$(swarm_users)" = "$SWARM_N" ]
out="$(load_accounts rj_swarm_dev "$SWARM_N")"; rc=$?
n_cards="$(sql rj_swarm_dev -e "SELECT COUNT(*) FROM user_player_card")"
check "loaded again: still $SWARM_N accounts, one player card each (found $(swarm_users), $n_cards)" \
  all [ "$rc" = 0 ] -- [ "$(swarm_users)" = "$SWARM_N" ] -- [ "$n_cards" = "$SWARM_N" ]
for db in rj_swarm_alpha rj_swarm_test; do
  sql -e "CREATE DATABASE $db; CREATE TABLE $db.users (user_id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(255) UNIQUE, email VARCHAR(255) UNIQUE, password VARCHAR(255), last_login DATETIME, created_date DATETIME)"
  out="$(load_accounts "$db")"; rc=$?
  check "swarm_accounts.sql refuses $db and writes nothing ($out)" \
    all [ "$rc" != 0 ] -- grep -q refused <<<"$out" -- [ "$(sql "$db" -e 'SELECT COUNT(*) FROM users')" = 0 ]
done
out="$(load_accounts -)"; rc=$?
check "swarm_accounts.sql refuses a connection with no database ($out)" all [ "$rc" != 0 ] -- grep -qE 'refused|No database selected' <<<"$out"

# --- drill 5 ---------------------------------------------------------------------------------------------------------
D5=(--api "$DEV_API" --local-root "$ROOT" --skip-client-check --config-url "$SWARM_CONFIG_URL" --wait 35
  --stop-cmd "$STOP_CMD" --start-cmd "$START_CMD" --user-dir "$TMP/swarm")

s0="$(live_serial)"
bash "$DRILLS/drill5_stampede.sh" "${D5[@]}" >"$TMP/plan.log" 2>&1; rc=$?
sed 's/^/    /' "$TMP/plan.log"
check "drill 5 PLAN passes (exit $rc)" all [ "$rc" = 0 ] -- grep -q 'DRILL5 RESULT: PASS' "$TMP/plan.log"
check "PLAN published nothing (serial $s0 -> $(live_serial))" [ "$(live_serial)" = "$s0" ]

echo "drill5_local: the drill with $SWARM_N clients (~7 min) ..."
bash "$DRILLS/drill5_stampede.sh" "${D5[@]}" --clients "$SWARM_N" --ramp 60 --steady 75 --outage 30 --after 120 --run \
  >"$TMP/run.log" 2>&1 &
drill_pid=$!
# Mid-drill: the raised limit is live while the swarm runs.
mid_limit=""
for _ in $(seq 1 240); do
  grep -q 'step 2: the swarm' "$TMP/run.log" 2>/dev/null && { mid_limit="$(live_limit)"; break; }
  kill -0 "$drill_pid" 2>/dev/null || break
  sleep 1
done
wait "$drill_pid"; rc=$?
sed 's/^/    /' "$TMP/run.log"
check "the login limit was raised for the drill ($ORIG_LIMIT -> ${mid_limit:-?})" [ "$mid_limit" = 2000 ]
check "the drill ran to a verdict" grep -qE '^STAMPEDE VERDICT: (PASS|FAIL)$' "$TMP/run.log"
measured() { ! grep -E '^STAMPEDE FAIL  ' "$1" | grep -vq '^STAMPEDE FAIL  peak reconnect bucket'; }
check "the measurement worked: no STAMPEDE FAIL line but the verdict's own" measured "$TMP/run.log"
outage="$(sed -nE 's/^SWARM  outage .*\(([0-9.]+) s\);.*/\1/p' "$TMP/run.log")"
check "the swarm measured the outage at about 30 s (${outage:-none})" \
  python3 -c 'import sys; v = float(sys.argv[1] or 0); sys.exit(0 if 27 <= v <= 40 else 1)' "${outage:-0}"
lost="$(sed -nE 's/^SWARM  outage .*; ([0-9]+) of ([0-9]+) clients lost.*/\1 \2/p' "$TMP/run.log")"
check "every client saw the outage ($lost)" all [ -n "$lost" ] -- [ "${lost% *}" = "${lost#* }" ]
check "dev's login limit is its own again ($(live_limit))" [ "$(live_limit)" = "$ORIG_LIMIT" ]
check "the brain answers after the drill" curl -sf "$DEV_API/v1/stats/columns" -H 'X-RJ-Api: 1' -H 'X-RJ-Env: dev' -H 'X-RJ-Build: 0' -o /dev/null
VERDICT="$(grep -E '^STAMPEDE (PASS|FAIL)  peak' "$TMP/run.log" | head -n 1)"
echo "drill5_local: the local stampede verdict -- ${VERDICT:-none} (drill exit $rc)"
creds="$(sql rj_swarm_dev -e 'SELECT COUNT(*) FROM user_credentials')"
check "the swarm signed in with $SWARM_N credentials, one per client ($creds)" [ "$creds" = "$SWARM_N" ]

# --- stopped with the brain down: the trap starts it and republishes ---------------------------------------------------
RJ_DRILL_FAIL_AT=after-stop bash "$DRILLS/drill5_stampede.sh" "${D5[@]}" --clients 20 --ramp 5 --window 5 --steady 15 \
  --outage 30 --after 30 --wait 1 --run >"$TMP/stopped.log" 2>&1; rc=$?
sed 's/^/    /' "$TMP/stopped.log"
check "stopped on purpose with the brain down, the drill fails (exit $rc)" all [ "$rc" != 0 ] -- grep -q 'DRILL5 RESULT: FAIL' "$TMP/stopped.log"
check "... and its trap started the brain again" grep -q 'PASS  restored: the brain was started again' "$TMP/stopped.log"
check "... which answers" curl -sf "$DEV_API/v1/stats/columns" -H 'X-RJ-Api: 1' -H 'X-RJ-Env: dev' -H 'X-RJ-Build: 0' -o /dev/null
check "... and republished dev's document (login limit $(live_limit))" [ "$(live_limit)" = "$ORIG_LIMIT" ]
check "a second swarm restored its kept credentials: still $SWARM_N in user_credentials" \
  [ "$(sql rj_swarm_dev -e 'SELECT COUNT(*) FROM user_credentials')" = "$SWARM_N" ]

if [ "$FAILED" = 0 ]; then echo "DRILL5 LOCAL: PASS"; else echo "DRILL5 LOCAL: FAIL"; exit 1; fi
