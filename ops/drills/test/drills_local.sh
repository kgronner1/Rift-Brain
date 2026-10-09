#!/usr/bin/env bash
# Runs drills 1, 2 and 7 against a local dev brain and a local alpha brain, never the real ones (RJ 470, spec M8).
#
#   bash ops/drills/test/drills_local.sh          ~5 min; needs Docker and node_modules (npm ci)
#   KEEP=1 bash ops/drills/test/drills_local.sh   leave the stack up at the end, for poking at
#
# The stack, all on 127.0.0.1: one MariaDB 10.11 container holding rj_dev and rj_alpha, both built by migrate; two
# brains (ENV=dev and ENV=alpha, each with its own fresh keys) on free ports; a local HTTPS server standing in for
# config.riftjumpers.space, serving a directory that ops/config/publish.sh --local-root publishes into, with a
# throwaway certificate the brains trust through NODE_EXTRA_CA_CERTS and the drills through RJ_DRILL_CACERT (the
# shape of Wobble Planet's Tools/harness/stack_loop.sh). Each brain's SERVERS_DIR has a manifest naming the checkout's
# wire as deployed; no game server is ever spawned, because no drill's join can be ok.
#
# Graded, each a TEST PASS / TEST FAIL line:
#   - every drill in PLAN mode passes and publishes nothing (the live serial does not move)
#   - every drill under --run passes; drill 1 leaves the original gates live; a second drill 7 restores the kept
#     credential instead of issuing another (one user_credentials row)
#   - drill 1 stopped on purpose after its first publish (RJ_DRILL_FAIL_AT) fails AND puts the original gates back
#   - the drills can fail: drill 7 pointed at the dev brain as "alpha", and drill 2 with the newer wire retired
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HERE/../../.." && pwd)"
DRILLS="$REPO_DIR/ops/drills"
DB_IMAGE="mariadb:10.11"

FAILED=0
tpass() { echo "TEST PASS  $*"; }
tfail() { FAILED=1; echo "TEST FAIL  $*"; }
tdie() { tfail "$*"; exit 1; }
check() { local label="$1"; shift; if "$@"; then tpass "$label"; else tfail "$label"; fi; }

if ! docker info >/dev/null 2>&1; then echo "drills_local.sh: Docker is not running"; exit 2; fi
[ -d "$REPO_DIR/node_modules" ] || { echo "drills_local.sh: run npm ci in $REPO_DIR first"; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/rj-drills.XXXXXX")"
DB_CONTAINER="rj-drills-$$"
PIDS=()
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: dev $DEV_API, alpha $ALPHA_API, config $CONFIG_BASE, db container $DB_CONTAINER, files $TMP"
  else
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

WP="${RJ_WOBBLE_PLANET:-$(cd "$REPO_DIR/.." && pwd)/Wobble Planet}"
WIRE="$(sed -nE 's/^const VERSION := ([0-9]+).*/\1/p' "$WP/Scripts/Net/WireProtocol.gd" 2>/dev/null)"
FP="$(sed -nE 's/^const FINGERPRINT := "([0-9a-f]+)".*/\1/p' "$WP/Scripts/Net/WireProtocol.gd" 2>/dev/null)"
[ -n "$WIRE" ] && [ -n "$FP" ] || tdie "no wire in $WP/Scripts/Net/WireProtocol.gd (set RJ_WOBBLE_PLANET)"
export RJ_WOBBLE_PLANET="$WP"

# --- the config server and its documents -------------------------------------------------------------------------
ROOT="$TMP/config-root"
mkdir -p "$ROOT"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1 || tdie "openssl could not make a certificate"
CONFIG_PORT="$(free_port)"
cat >"$TMP/serve.py" <<'PY'
import functools, http.server, ssl, sys
port, root, cert, key = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=root))
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print("config server up", flush=True)
srv.serve_forever()
PY
python3 -I "$TMP/serve.py" "$CONFIG_PORT" "$ROOT" "$TMP/cert.pem" "$TMP/key.pem" >"$TMP/config.log" 2>&1 &
PIDS+=($!)
wait_log "$TMP/config.log" "config server up" 10 || tdie "the config server did not start"
CONFIG_BASE="https://127.0.0.1:$CONFIG_PORT"
export RJ_DRILL_CONFIG_BASE="$CONFIG_BASE" RJ_DRILL_CACERT="$TMP/cert.pem" RJ_DRILL_STATE_DIR="$TMP/state"

for env in dev alpha; do
  bash "$REPO_DIR/ops/config/publish.sh" "$env" --local-root "$ROOT" --skip-client-check >"$TMP/publish.$env.log" 2>&1 \
    || { cat "$TMP/publish.$env.log"; tdie "publishing the $env document into the local root"; }
done
live_serial() { node "$REPO_DIR/ops/config/doc.mjs" serial "$ROOT/dev/client.v1.json"; }
gates_of() { node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1])).gates))' "$1"; }
ORIG_GATES="$(gates_of "$REPO_DIR/config/dev.client.v1.json")"

# --- the database ------------------------------------------------------------------------------------------------
DB_PW="$(openssl rand -hex 12)"
DB_PORT="$(free_port)"
docker run -d --rm --name "$DB_CONTAINER" -e MARIADB_ROOT_PASSWORD="$DB_PW" -e MARIADB_DATABASE=rj_dev \
  -p "127.0.0.1:$DB_PORT:3306" "$DB_IMAGE" >"$TMP/docker.log" 2>&1 || { cat "$TMP/docker.log"; tdie "docker run"; }
sql() { docker exec "$DB_CONTAINER" mariadb -h127.0.0.1 -uroot -p"$DB_PW" -N -B "$@"; }
up=0
for _ in $(seq 1 120); do sql -e 'SELECT 1' >/dev/null 2>&1 && { up=1; break; }; sleep 0.5; done
[ "$up" = 1 ] || tdie "the database never came up"
sql -e 'CREATE DATABASE rj_alpha' || tdie "CREATE DATABASE rj_alpha"

# --- the brains --------------------------------------------------------------------------------------------------
start_brain() {  # start_brain <env> -> sets <ENV>_API
  local env="$1" pub internal dir
  pub="$(free_port)"; internal="$(free_port)"; dir="$TMP/$env"
  mkdir -p "$dir/servers/wire-$WIRE-$FP" "$dir/logs"
  : >"$dir/servers/wire-$WIRE-$FP/server.x86_64"
  write_manifest "$env" active
  local e=(ENV="$env" BIND_HOST=127.0.0.1 PUBLIC_PORT="$pub" INTERNAL_PORT="$internal" GAME_HOST=127.0.0.1
    GAME_PORTS="$(( pub % 1000 + 40000 ))-$(( pub % 1000 + 40001 ))" SERVERS_DIR="$dir/servers" SERVER_LOGS_DIR="$dir/logs"
    SESSION_KEY="$(openssl rand -hex 32)" JOIN_KEY="$(openssl rand -hex 32)" LOBBY_MASTER_KEY="$(openssl rand -hex 32)"
    MYSQL_HOST=127.0.0.1 MYSQL_PORT="$DB_PORT" MYSQL_USER=root MYSQL_PASSWORD="$DB_PW" MYSQL_DATABASE="rj_$env"
    CONFIG_URL="$CONFIG_BASE/$env/client.v1.json" NODE_EXTRA_CA_CERTS="$TMP/cert.pem")
  (cd "$REPO_DIR" && env "${e[@]}" node src/migrate.js) >"$dir/migrate.log" 2>&1 || { cat "$dir/migrate.log"; tdie "migrate $env"; }
  (cd "$REPO_DIR" && exec env "${e[@]}" node src/app.js) >"$dir/brain.log" 2>&1 &
  PIDS+=($!)
  wait_log "$dir/brain.log" "public listener" 20 || { tail -20 "$dir/brain.log"; tdie "the $env brain did not start"; }
  wait_log "$dir/brain.log" "\[CONFIG\] serial 1 \($env\)" 10 || tdie "the $env brain did not fetch its document"
  printf -v "$(tr '[:lower:]' '[:upper:]' <<<"$env")_API" '%s' "http://127.0.0.1:$pub"
}
write_manifest() {  # write_manifest <env> <status of wire+1, or "active" for none>
  local dir="$TMP/$1/servers" extra=""
  [ "$2" = active ] || extra=", { \"wire\": $((WIRE + 1)), \"fp\": \"$FP\", \"path\": \"wire-$WIRE-$FP/server.x86_64\", \"sha\": \"x\", \"deployed_at\": \"2026-10-09T00:00:00Z\", \"status\": \"$2\" }"
  printf '{ "servers": [ { "wire": %s, "fp": "%s", "path": "wire-%s-%s/server.x86_64", "sha": "x", "deployed_at": "2026-10-09T00:00:00Z", "status": "active" }%s ] }\n' \
    "$WIRE" "$FP" "$WIRE" "$FP" "$extra" >"$dir/manifest.json.tmp"
  mv "$dir/manifest.json.tmp" "$dir/manifest.json"
}
DEV_API=""; ALPHA_API=""
start_brain dev
start_brain alpha
tpass "dev brain $DEV_API and alpha brain $ALPHA_API up, each on its own document (wire $WIRE/$FP deployed)"

# A dev account, as a scrubbed dev database has them.
RJ_DRILL_PASSWORD="drill-$(openssl rand -hex 6)"
export RJ_DRILL_PASSWORD
DRILL_USER="drilluser$(openssl rand -hex 2)"
reply="$(curl -s -X POST "$DEV_API/v1/accounts" -H 'Content-Type: application/json' -H 'X-RJ-Api: 1' -H 'X-RJ-Env: dev' \
  -H 'X-RJ-Build: 0' -H 'X-RJ-Platform: macos' -H 'X-RJ-Install: drills-local' \
  --data "{\"username\":\"$DRILL_USER\",\"email\":\"$DRILL_USER@example.invalid\",\"password\":\"$RJ_DRILL_PASSWORD\"}")"
grep -q '"result":"ok"' <<<"$reply" || { echo "$reply"; tdie "POST /v1/accounts"; }
sql rj_dev -e 'DELETE FROM user_credentials'

# run_drill <label> <want rc: 0|nonzero> <script> <args...>
run_drill() {
  local label="$1" want="$2" script="$3" log rc
  shift 3
  log="$TMP/$label.log"
  bash "$DRILLS/$script" "$@" >"$log" 2>&1
  rc=$?
  sed 's/^/    /' "$log"
  if { [ "$want" = 0 ] && [ "$rc" = 0 ] && grep -q 'RESULT: PASS' "$log"; } \
    || { [ "$want" != 0 ] && [ "$rc" != 0 ] && grep -q 'RESULT: FAIL' "$log"; }; then
    tpass "$label (exit $rc, as wanted)"
  else
    tfail "$label (exit $rc; wanted $([ "$want" = 0 ] && echo a pass || echo a failure))"
  fi
}

D1=(--build 5000 --api "$DEV_API" --local-root "$ROOT" --skip-client-check --wait 90)

# --- plan mode changes nothing -------------------------------------------------------------------------------------
s0="$(live_serial)"
run_drill "drill 7 plan" 0 drill7_env_isolation.sh --dev-api "$DEV_API" --alpha-api "$ALPHA_API"
run_drill "drill 2 plan" 0 drill2_server_behind.sh --api "$DEV_API"
run_drill "drill 1 plan" 0 drill1_version_floor.sh "${D1[@]}"
check "plan mode published nothing (dev serial $s0 -> $(live_serial))" [ "$(live_serial)" = "$s0" ]

# --- the drills -------------------------------------------------------------------------------------------------------
run_drill "drill 7 run" 0 drill7_env_isolation.sh --dev-api "$DEV_API" --alpha-api "$ALPHA_API" --user "$DRILL_USER" --run
run_drill "drill 7 run again" 0 drill7_env_isolation.sh --dev-api "$DEV_API" --alpha-api "$ALPHA_API" --user "$DRILL_USER" --run
check "the second run restored the kept credential" grep -q 'restoring the kept credential' "$TMP/drill 7 run again.log"
n="$(sql rj_dev -e 'SELECT COUNT(*) FROM user_credentials')"
check "two runs left one credential in dev (found $n)" [ "$n" = 1 ]

run_drill "drill 2 run" 0 drill2_server_behind.sh --api "$DEV_API" --user "$DRILL_USER" --run

run_drill "drill 1 run" 0 drill1_version_floor.sh "${D1[@]}" --user "$DRILL_USER" --run
check "drill 1 left the original gates live: $(gates_of "$ROOT/dev/client.v1.json")" [ "$(gates_of "$ROOT/dev/client.v1.json")" = "$ORIG_GATES" ]

# --- a drill that fails restores what it changed ------------------------------------------------------------------
RJ_DRILL_FAIL_AT=after-build-publish run_drill "drill 1 stopped after its first publish" 1 \
  drill1_version_floor.sh "${D1[@]}" --user "$DRILL_USER" --run
check "the stopped drill 1 said it restored" grep -q 'PASS  restored' "$TMP/drill 1 stopped after its first publish.log"
check "the stopped drill 1 left the original gates live" [ "$(gates_of "$ROOT/dev/client.v1.json")" = "$ORIG_GATES" ]

# --- the drills can fail -----------------------------------------------------------------------------------------
run_drill "drill 7 with the dev brain posing as alpha" 1 drill7_env_isolation.sh --dev-api "$DEV_API" \
  --alpha-api "${DEV_API/127.0.0.1/localhost}" --user "$DRILL_USER" --run
write_manifest dev retired
run_drill "drill 2 with wire $((WIRE + 1)) retired" 1 drill2_server_behind.sh --api "$DEV_API" --user "$DRILL_USER" --run
write_manifest dev active

if [ "$FAILED" = 0 ]; then echo "DRILLS LOCAL: PASS"; else echo "DRILLS LOCAL: FAIL"; exit 1; fi
