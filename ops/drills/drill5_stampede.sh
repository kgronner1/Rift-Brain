#!/usr/bin/env bash
# Release drill 5 (spec M8 and M9, RJ 471): the stampede. Dev only.
#
#   bash ops/drills/drill5_stampede.sh                 PLAN: read-only probes; prints what --run would do
#   bash ops/drills/drill5_stampede.sh --run           the drill (~8 min at the defaults)
#
#   --clients N          the swarm's size (default 500); its accounts are swarm0001.. (ops/drills/swarm_accounts.sql)
#   --processes P        swarm processes, the clients split between them (default 1: one holds 500, RJ 471)
#   --ramp SEC           the clients start one by one across this (default 120: 500 password logins are bcrypt work)
#   --beat SEC           each client's natural trigger, x [0.5, 1.5) (default 15; Wobble Planet's NetSwarm.gd)
#   --steady SEC         how long the swarm runs signed in before the brain stops (default 90; at least --window + 10)
#   --outage SEC         how long the brain stays stopped (default 30)
#   --after SEC          how long the swarm runs after the brain is started again (default 150)
#   --window SEC         the report's steady window (default 60); --factor F its limit (default 2)
#   --login-limit N      server.rate_limits.login_per_min_ip for the drill (default 2000; dev's is 10, and every swarm
#                        login comes from this Mac's one address)
#   --user-dir DIR       the swarm's --user_dir root (default $RJ_DRILL_STATE_DIR/swarm.dev): a second run restores
#                        the credentials the first was issued instead of issuing new ones
#   --api URL            the brain (default https://api-dev.riftjumpers.space)
#   --wait SEC           how long to give the brain to take up a published document (default 45: its 30 s refresh)
# Local test seams (ops/drills/test/drill5_local.sh): --config-url URL (the swarm's --config_url), --stop-cmd CMD and
# --start-cmd CMD (how the brain is stopped and started; default pm2 over SSH with deploy.env), --local-root DIR and
# --skip-client-check (passed to ops/config/publish.sh).
#
# What --run does:
#   1. reads the live dev document and keeps it; publishes it with server.rate_limits.login_per_min_ip raised to
#      --login-limit (nothing else changes; no build is locked out), then waits --wait for the brain to take it up
#   2. starts the swarm (Wobble Planet's --net_swarm, from the checkout beside this one, RJ_WOBBLE_PLANET, with
#      RJ_GODOT) and waits until every client is signed in, then --steady seconds
#   3. stops the brain (pm2 stop rift-brain-dev), waits --outage seconds, starts it again (pm2 start rift-brain-dev)
#      and checks it answers
#   4. lets the swarm run --after seconds more, then reports (ops/drills/swarm_report.py: the histogram and the verdict)
#   5. republishes the kept document: dev's rate limits as they were
# On any failure or Ctrl-C an EXIT trap stops the swarm, starts the brain again if the drill stopped it, and republishes
# the kept document -- unless someone else published dev meanwhile, when it changes nothing and says what to do.
# The swarm's logs and the report are kept in $RJ_DRILL_STATE_DIR/drill5-<time>/.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=../config/_lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../config/_lib.sh"
DRILL_NAME=DRILL5
# shellcheck source-path=SCRIPTDIR source=_drill.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_drill.sh"

ENV_NAME=dev
CLIENTS=500
PROCESSES=1
RAMP=120
BEAT=15
STEADY=90
OUTAGE=30
AFTER=150
WINDOW=60
FACTOR=2
LOGIN_LIMIT=2000
USER_DIR=""
API=""
WAIT_SEC=45
CONFIG_URL=""
STOP_CMD=""
START_CMD=""
RUN=0
LOCAL_ROOT=""
PUBLISH_PASS=()
GODOT="${RJ_GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"

int_arg() { [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge "${3:-1}" ] || die "$1 needs a whole number of at least ${3:-1}, not '$2'"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --clients) int_arg "$1" "${2:-}"; CLIENTS="$2"; shift 2 ;;
    --processes) int_arg "$1" "${2:-}"; PROCESSES="$2"; shift 2 ;;
    --ramp) int_arg "$1" "${2:-}" 0; RAMP="$2"; shift 2 ;;
    --beat) int_arg "$1" "${2:-}"; BEAT="$2"; shift 2 ;;
    --steady) int_arg "$1" "${2:-}"; STEADY="$2"; shift 2 ;;
    --outage) int_arg "$1" "${2:-}"; OUTAGE="$2"; shift 2 ;;
    --after) int_arg "$1" "${2:-}"; AFTER="$2"; shift 2 ;;
    --window) int_arg "$1" "${2:-}"; WINDOW="$2"; shift 2 ;;
    --factor) [[ "${2:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--factor needs a number"; FACTOR="$2"; shift 2 ;;
    --login-limit) int_arg "$1" "${2:-}"; LOGIN_LIMIT="$2"; shift 2 ;;
    --user-dir) USER_DIR="${2:?--user-dir needs a directory}"; shift 2 ;;
    --api) API="${2:?}"; shift 2 ;;
    --wait) int_arg "$1" "${2:-}" 0; WAIT_SEC="$2"; shift 2 ;;
    --config-url) CONFIG_URL="${2:?}"; shift 2 ;;
    --stop-cmd) STOP_CMD="${2:?}"; shift 2 ;;
    --start-cmd) START_CMD="${2:?}"; shift 2 ;;
    --run) RUN=1; shift ;;
    --local-root) LOCAL_ROOT="${2:?}"; PUBLISH_PASS+=(--local-root "$2"); shift 2 ;;
    --skip-client-check) PUBLISH_PASS+=(--skip-client-check); shift ;;
    --env) [ "${2:-}" = dev ] || die "drill 5 runs against dev only: it stops the brain"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

[ "$CLIENTS" -le 2000 ] || die "--clients is at most 2000 (NetSwarm.MAX_CLIENTS)"
[ "$PROCESSES" -le "$CLIENTS" ] || die "--processes cannot exceed --clients"
[ "$STEADY" -ge $((WINDOW + 10)) ] || die "--steady must be at least --window + 10 ($((WINDOW + 10))): the report needs a full steady window before the outage"
{ [ -n "$STOP_CMD" ] && [ -n "$START_CMD" ]; } || { [ -z "$STOP_CMD" ] && [ -z "$START_CMD" ]; } \
  || die "--stop-cmd and --start-cmd go together"
API="${API:-$(api_for_env "$ENV_NAME")}"
USER_DIR="${USER_DIR:-$DRILL_STATE_DIR/swarm.$ENV_NAME}"
WP="$(wp_dir)"
REPORT_PY="$DRILL_DIR/swarm_report.py"

# The brain's stop and start: pm2 over SSH (deploy.env), unless the local test gave its own.
SSH=()
DEPLOY_ENV=""
if [ -z "$STOP_CMD" ]; then
  DEPLOY_ENV="${RJ_DEPLOY_ENV_FILE:-$HOME/.config/rift-jumpers/deploy.env}"
  STOP_CMD="pm2 stop rift-brain-$ENV_NAME"
  START_CMD="pm2 start rift-brain-$ENV_NAME"
fi
brain_cmd() {  # brain_cmd <command>: on the box, or locally under the test seams
  if [ ${#SSH[@]} -gt 0 ]; then "${SSH[@]}" "$1"; else bash -c "$1"; fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-drill5.XXXXXX")"
ORIG="$WORK/original.json"
RAISED="$WORK/raised.json"
RESTORE_NEEDED=0
BRAIN_STOPPED=0
LAST_SERIAL=""
SWARM_PIDS=()

fetch_live() {
  if [ -n "$LOCAL_ROOT" ]; then
    cp "$(local_live "$ENV_NAME")" "$1"
  else
    edge_outputs
    aws_rj s3api get-object --region "$RJ_EDGE_REGION" --bucket "$CONFIG_BUCKET" --key "$(config_key "$ENV_NAME")" \
      "$1" >/dev/null
  fi
}

publish() {  # publish <file>: publish.sh's own output goes to the log, its verdict here
  local log="$WORK/publish.$RANDOM.log"
  if bash "$OPS_DIR/publish.sh" "$ENV_NAME" --file "$1" ${PUBLISH_PASS[@]+"${PUBLISH_PASS[@]}"} >"$log" 2>&1; then
    LAST_SERIAL="$(sed -nE 's/.*published [a-z]+ serial ([0-9]+).*/\1/p' "$log" | tail -n 1)"
    say "published $ENV_NAME serial $LAST_SERIAL"
    return 0
  fi
  sed 's/^/    /' "$log" >&2
  return 1
}

stop_swarm() {
  local p
  [ ${#SWARM_PIDS[@]} -gt 0 ] || return 0
  for p in "${SWARM_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  for p in "${SWARM_PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
  SWARM_PIDS=()
}

restore() {
  local rc=$?
  trap - EXIT INT TERM
  stop_swarm
  if [ "$BRAIN_STOPPED" = 1 ]; then
    say "starting the brain again: $START_CMD"
    if brain_cmd "$START_CMD" >"$WORK/start.trap.log" 2>&1; then
      pass "restored: the brain was started again"
    else
      fail "RESTORE FAILED: the brain did not start. Start it now: $START_CMD (on the box)"
      sed 's/^/    /' "$WORK/start.trap.log"
    fi
  fi
  if [ "$RESTORE_NEEDED" = 1 ]; then
    local now="$WORK/now.json" live_serial=""
    if fetch_live "$now" 2>/dev/null; then live_serial="$(node "$OPS_DIR/doc.mjs" serial "$now")"; fi
    if [ -n "$LAST_SERIAL" ] && [ "$live_serial" != "$LAST_SERIAL" ]; then
      fail "RESTORE SKIPPED: dev is at serial ${live_serial:-unknown}, not the drill's $LAST_SERIAL -- someone else published meanwhile. Check server.rate_limits there, then put it back by hand: bash ops/config/rollback.sh dev --list"
    else
      say "restoring the original dev document (its rate limits)"
      if publish "$ORIG"; then
        pass "restored: the original document is live again (serial $LAST_SERIAL)"
      else
        fail "RESTORE FAILED: dev's login limit may still be raised. Put it back now: bash ops/config/rollback.sh dev --list, then bash ops/config/rollback.sh dev <version id>"
      fi
    fi
    [ "$rc" = 0 ] && rc=1
  fi
  [ "$rc" = 0 ] || [ -n "${VERDICT_PRINTED:-}" ] || echo "$DRILL_NAME RESULT: FAIL"
  rm -rf "$WORK"
  exit "$rc"
}
trap restore EXIT
trap 'exit 130' INT TERM

# A test seam: RJ_DRILL_FAIL_AT=<step> stops the drill there, as a failure would (ops/drills/test/drill5_local.sh).
fault() { [ "${RJ_DRILL_FAIL_AT:-}" != "$1" ] || { fail "RJ_DRILL_FAIL_AT=$1: stopping here on purpose"; exit 1; }; }

brain_answers() { call "$API" GET /v1/stats/columns "$ENV_NAME" 0 macos - - - -; }

SWARM_SEC=$((RAMP + 120 + STEADY + OUTAGE + AFTER))
echo "Drill 5: stampede -- $ENV_NAME, $API"
echo "  $CLIENTS clients in $PROCESSES process(es), ramp ${RAMP}s, beat ${BEAT}s; steady ${STEADY}s, brain stopped ${OUTAGE}s, then ${AFTER}s"
echo "  verdict: no 1 s reconnect bucket above ${FACTOR}x the mean over the first full ${WINDOW}s steady window"

# --- read-only probes (PLAN and --run) ------------------------------------------------------------------------------
[ -x "$GODOT" ] || die "no Godot at $GODOT (set RJ_GODOT)"
[ -f "$WP/Scripts/Net/NetSwarm.gd" ] || die "no Wobble Planet with the swarm at $WP (set RJ_WOBBLE_PLANET)"
command -v python3 >/dev/null || die "python3 is needed for the report"
brain_answers; expect "the brain answers" '^200 ok '
fetch_live "$ORIG" || die "could not read the live $ENV_NAME document"
live_limit="$(node "$DRILL_MJS" get "$ORIG" server.rate_limits.login_per_min_ip)"
say "the live $ENV_NAME document is serial $(node "$OPS_DIR/doc.mjs" serial "$ORIG"), login_per_min_ip ${live_limit:-?}"
node "$DRILL_MJS" set "$ORIG" server.rate_limits.login_per_min_ip "$LOGIN_LIMIT" >"$RAISED"
if [ -n "$DEPLOY_ENV" ] && [ "$RUN" = 1 ]; then
  [ -f "$DEPLOY_ENV" ] || die "no $DEPLOY_ENV (RJ_DEPLOY_PEM, RJ_DEPLOY_HOST): the brain is stopped over SSH"
  # shellcheck source=/dev/null
  . "$DEPLOY_ENV"
  [ -n "${RJ_DEPLOY_PEM:-}" ] && [ -n "${RJ_DEPLOY_HOST:-}" ] || die "$DEPLOY_ENV must set RJ_DEPLOY_PEM and RJ_DEPLOY_HOST"
  SSH=(ssh -i "$RJ_DEPLOY_PEM" -o ConnectTimeout=15 "$RJ_DEPLOY_HOST")
fi

SWARM_ARGS=(--headless --path "$WP" --net_env=dev "--net_swarm_ramp=$RAMP" "--net_swarm_beat=$BEAT"
  "--net_swarm_sec=$SWARM_SEC")
[ "$API" = "$(api_for_env "$ENV_NAME")" ] || SWARM_ARGS+=("--api_url=$API")
[ -z "$CONFIG_URL" ] || SWARM_ARGS+=("--config_url=$CONFIG_URL")

if [ "$RUN" = 0 ]; then
  echo
  echo "PLAN: nothing published, no swarm, the brain untouched. --run would:"
  echo "  1. publish dev with server.rate_limits.login_per_min_ip ${live_limit:-?} -> $LOGIN_LIMIT (publish.sh --dry-run follows)"
  bash "$OPS_DIR/publish.sh" "$ENV_NAME" --file "$RAISED" --dry-run ${PUBLISH_PASS[@]+"${PUBLISH_PASS[@]}"} 2>&1 \
    | grep -E 'rate_limits|locks builds out|refuse|^  - ' | sed 's/^/     /' || true
  echo "  2. run $PROCESSES swarm process(es) for up to ${SWARM_SEC}s, user dirs under $USER_DIR:"
  echo "     $GODOT --user_dir=$USER_DIR/p1 ${SWARM_ARGS[*]} --net_swarm=<N> --net_swarm_first=<first> --net_swarm_log=<file>"
  echo "  3. once every client is signed in and ${STEADY}s later: $STOP_CMD; ${OUTAGE}s; $START_CMD$([ -n "$DEPLOY_ENV" ] && echo " (over SSH, $DEPLOY_ENV)")"
  echo "  4. ${AFTER}s later: python3 ops/drills/swarm_report.py <the logs> --window $WINDOW --factor $FACTOR"
  echo "  5. republish the document it read (serial $(node "$OPS_DIR/doc.mjs" serial "$ORIG")), so the login limit is ${live_limit:-?} again"
  echo "The accounts must exist first: ops/drills/swarm_accounts.sql (docs/release-drills.md, drill 5)."
  verdict
  exit $?
fi

# --- 1. the rate limit ------------------------------------------------------------------------------------------------
[ "$DRILL_FAILED" = 0 ] || { fail "the brain does not answer: nothing published"; exit 1; }
echo "--- step 1: login_per_min_ip ${live_limit:-?} -> $LOGIN_LIMIT"
RESTORE_NEEDED=1
publish "$RAISED" || { fail "publish of the raised login limit"; exit 1; }
fault after-publish
say "waiting ${WAIT_SEC}s for the brain to take it up (it re-reads its document every 30 s)"
sleep "$WAIT_SEC"

# --- 2. the swarm -------------------------------------------------------------------------------------------------------
echo "--- step 2: the swarm, $CLIENTS clients"
ulimit -n 8192 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
per=$(( (CLIENTS + PROCESSES - 1) / PROCESSES ))
first=1
LOGS=()
for p in $(seq 1 "$PROCESSES"); do
  n=$(( CLIENTS - first + 1 < per ? CLIENTS - first + 1 : per ))
  [ "$n" -gt 0 ] || break
  mkdir -p "$USER_DIR/p$p"
  RJ_SWARM_PASSWORD="${RJ_DRILL_PASSWORD:-riftjumpers-dev}" "$GODOT" "--user_dir=$USER_DIR/p$p" "${SWARM_ARGS[@]}" \
    "--net_swarm=$n" "--net_swarm_first=$first" "--net_swarm_log=$WORK/requests.$p.csv" >"$WORK/swarm.$p.log" 2>&1 &
  SWARM_PIDS+=($!)
  LOGS+=("$WORK/swarm.$p.log")
  say "swarm process $p: clients $first..$((first + n - 1)) (pid $!)"
  first=$((first + n))
done
fault after-swarm-start
t0="$(date +%s)"
for log in "${LOGS[@]}"; do
  until grep -q '^\[SWARM\] all [0-9]* clients signed in' "$log" 2>/dev/null; do
    if [ $(( $(date +%s) - t0 )) -gt $((RAMP + 120)) ]; then
      fail "not every client signed in within $((RAMP + 120))s: $(grep '^\[SWARM\] t=' "$log" | tail -n 1)"
      grep -E 'AUTH_INVALID|RATE_LIMITED' "$log" | head -n 3 | sed 's/^/    /'
      exit 1
    fi
    for pid in "${SWARM_PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || { fail "a swarm process died: $(tail -n 3 "$log")"; exit 1; }; done
    sleep 2
  done
done
pass "every client signed in after $(( $(date +%s) - t0 ))s"
say "running ${STEADY}s signed in (the steady window)"
sleep "$STEADY"

# --- 3. the outage ------------------------------------------------------------------------------------------------------
echo "--- step 3: the brain stops for ${OUTAGE}s"
BRAIN_STOPPED=1
brain_cmd "$STOP_CMD" >"$WORK/stop.log" 2>&1 || { sed 's/^/    /' "$WORK/stop.log"; fail "stopping the brain: $STOP_CMD"; exit 1; }
say "stopped at $(date +%H:%M:%S)"
fault after-stop
sleep 2
brain_answers; expect "the brain is down: nothing answers ok" '^(000|502|503) '
sleep $((OUTAGE - 2 > 0 ? OUTAGE - 2 : 0))
brain_cmd "$START_CMD" >"$WORK/start.log" 2>&1 || { sed 's/^/    /' "$WORK/start.log"; fail "starting the brain: $START_CMD"; exit 1; }
BRAIN_STOPPED=0
say "started at $(date +%H:%M:%S)"
wait_for_reply 60 '^200 ok ' brain_answers || true
expect "the brain answers again" '^200 ok '

# --- 4. the reconnects and the report -------------------------------------------------------------------------------------
echo "--- step 4: the reconnects (${AFTER}s), then the report"
for pid in "${SWARM_PIDS[@]}"; do
  for _ in $(seq 1 $((AFTER + 180))); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
done
stop_swarm
KEEP="$DRILL_STATE_DIR/drill5-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$KEEP"
cp "$WORK"/requests.*.csv "$WORK"/swarm.*.log "$KEEP"/ 2>/dev/null || true
set +e
python3 "$REPORT_PY" "$KEEP"/requests.*.csv --window "$WINDOW" --factor "$FACTOR" --json "$KEEP/report.json" | tee "$KEEP/report.txt"
report_rc=${PIPESTATUS[0]}
set -e
if [ "$report_rc" = 0 ]; then
  pass "the stampede verdict: PASS (report in $KEEP)"
else
  fail "the stampede verdict: FAIL (report in $KEEP)"
fi

# --- 5. the rate limit back -----------------------------------------------------------------------------------------------
echo "--- step 5: dev's document as it was"
publish "$ORIG" || { fail "republishing the original document"; exit 1; }
RESTORE_NEEDED=0
pass "restored: login_per_min_ip ${live_limit:-?} again (serial $LAST_SERIAL)"
verdict
