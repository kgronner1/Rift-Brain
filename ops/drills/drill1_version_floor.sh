#!/usr/bin/env bash
# Release drill 1 (spec M8): a version floor above the live build. Dev only.
#
#   bash ops/drills/drill1_version_floor.sh --build <N> [--user user<id>] [options]          PLAN (changes nothing)
#   bash ops/drills/drill1_version_floor.sh --build <N> --user user<id> --run [options]      the drill
#
#   --build N            the build on the phone (its corner reads "DEV · <N> · <sha>"); the floors go to N+1
#   --platform P         the platform key the floor is raised under (default android)
#   --wire W             the phone's wire VERSION (default: Wobble Planet's Scripts/Net/WireProtocol.gd); min_wire -> W+1
#   --user user<id>      a dev account, for the wire step (match/join is behind a session); without it the wire
#                        step is skipped and the drill cannot pass
#   --api URL            the brain (default https://api-dev.riftjumpers.space)
#   --wait SEC           how long to wait for the brain to take each document up (default 180)
#   --pause              after each step's checks, wait for Enter: time to restart the app on the phone and look
#   --local-root DIR, --skip-client-check     passed to ops/config/publish.sh (tests: no AWS at all)
#
# What --run does, each step checked over HTTP against the brain, which enforces exactly the gates the client does:
#   0. reads the live dev document and keeps it; checks the gates are open for build N and wire W
#   1. publishes it with gates.min_build_multiplayer.<platform> = N+1 (--confirm-lock): POST /v1/match/join from
#      build N answers UPDATE_REQUIRED (scope multiplayer, retry never, open_store); build N+1 passes the gate;
#      a route outside multiplayer (POST /v1/session) is not gated -- single player and sign-in are unaffected
#   2. publishes it with gates.min_wire = W+1 instead (the build floor back as it was): a signed-in join on wire W
#      answers UPDATE_REQUIRED; build N passes the build gate again
#   3. republishes the document it kept: both gates open again
# On any failure or interrupt after step 1 began, an EXIT trap republishes the kept document -- unless someone else
# published dev meanwhile, in which case it changes nothing and says how to put it back by hand.
#
# What the phone shows meanwhile (the update screen, no automatic retries, single player unaffected, the lock
# lifting) is Wobble Planet's docs/release-drills.md, drill 1.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=../config/_lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../config/_lib.sh"
DRILL_NAME=DRILL1
# shellcheck source-path=SCRIPTDIR source=_drill.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_drill.sh"

ENV_NAME=dev
BUILD=""
PLATFORM=android
WIRE=""
USER_NAME=""
API=""
WAIT_SEC=180
RUN=0
PAUSE=0
LOCAL_ROOT=""
PUBLISH_PASS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD="${2:?--build needs a number}"; shift 2 ;;
    --platform) PLATFORM="${2:?}"; shift 2 ;;
    --wire) WIRE="${2:?}"; shift 2 ;;
    --user) USER_NAME="${2:?}"; shift 2 ;;
    --api) API="${2:?}"; shift 2 ;;
    --wait) WAIT_SEC="${2:?}"; shift 2 ;;
    --run) RUN=1; shift ;;
    --pause) PAUSE=1; shift ;;
    --local-root) LOCAL_ROOT="${2:?}"; PUBLISH_PASS+=(--local-root "$2"); shift 2 ;;
    --skip-client-check) PUBLISH_PASS+=(--skip-client-check); shift ;;
    --env) [ "${2:-}" = dev ] || die "drill 1 runs against dev only: it locks builds out"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

[[ "$BUILD" =~ ^[0-9]+$ ]] || die "--build <N> is required: the build on the phone (its DEV corner shows it)"
[[ "$PLATFORM" =~ ^[a-z0-9_]+$ ]] || die "--platform must be a platform key such as android or ios"
WIRE="${WIRE:-$(wp_wire)}"
[[ "$WIRE" =~ ^[0-9]+$ ]] || die "--wire <W> is required (no Wobble Planet checkout at $(wp_dir) to read it from)"
API="${API:-$(api_for_env "$ENV_NAME")}"
LOCK_BUILD=$((BUILD + 1))
LOCK_WIRE=$((WIRE + 1))
ZERO_FP=0000000000000000

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-drill1.XXXXXX")"
ORIG="$WORK/original.json"
RESTORE_NEEDED=0
LAST_SERIAL=""

# The live document, read the way publish.sh reads it (S3 itself, not the CDN, which can lag).
fetch_live() {
  if [ -n "$LOCAL_ROOT" ]; then
    cp "$(local_live "$ENV_NAME")" "$1"
  else
    edge_outputs
    aws_rj s3api get-object --region "$RJ_EDGE_REGION" --bucket "$CONFIG_BUCKET" --key "$(config_key "$ENV_NAME")" \
      "$1" >/dev/null
  fi
}

publish() {  # publish <file> [--confirm-lock]: publish.sh's own output goes to the log, its verdict here
  local log="$WORK/publish.$RANDOM.log"
  if bash "$OPS_DIR/publish.sh" "$ENV_NAME" --file "$1" "${@:2}" ${PUBLISH_PASS[@]+"${PUBLISH_PASS[@]}"} >"$log" 2>&1; then
    LAST_SERIAL="$(sed -nE 's/.*published [a-z]+ serial ([0-9]+).*/\1/p' "$log" | tail -n 1)"
    say "published $ENV_NAME serial $LAST_SERIAL"
    return 0
  fi
  sed 's/^/    /' "$log" >&2
  return 1
}

restore() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$RESTORE_NEEDED" = 1 ]; then
    local now="$WORK/now.json" live_serial=""
    if fetch_live "$now" 2>/dev/null; then live_serial="$(node "$OPS_DIR/doc.mjs" serial "$now")"; fi
    if [ -n "$LAST_SERIAL" ] && [ "$live_serial" != "$LAST_SERIAL" ]; then
      fail "RESTORE SKIPPED: dev is at serial ${live_serial:-unknown}, not the drill's $LAST_SERIAL -- someone else published meanwhile. Check it, then put the original back by hand: bash ops/config/rollback.sh dev --list"
    else
      say "restoring the original dev document"
      if publish "$ORIG"; then
        pass "restored: the original document is live again (serial $LAST_SERIAL)"
      else
        fail "RESTORE FAILED: the dev floors may still be raised. Put them back now: bash ops/config/rollback.sh dev --list, then bash ops/config/rollback.sh dev <version id>"
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

# A test seam: RJ_DRILL_FAIL_AT=<step> stops the drill there, as a failure would (ops/drills/test/drills_local.sh).
fault() { [ "${RJ_DRILL_FAIL_AT:-}" != "$1" ] || { fail "RJ_DRILL_FAIL_AT=$1: stopping here on purpose"; exit 1; }; }

# --pause: hold here until Enter, so the phone can be looked at while this step's document is live.
hold() {
  [ "$PAUSE" = 1 ] || return 0
  read -r -p "[$DRILL_NAME] $1 -- look at the phone, then press Enter " _ </dev/tty || true
}

# The probes. build_gate: an unsigned join from <build> (the build gates run before auth, so AUTH_REQUIRED = open).
build_gate() { call "$API" POST /v1/match/join "$ENV_NAME" "$1" "$PLATFORM" "$WIRE" "$ZERO_FP" '{"mode":"quickplay"}' -; }
# wire_gate: a signed-in join on <wire> with a fingerprint no server has: UPDATE_REQUIRED below the floor, else
# SERVER_BEHIND. Never ok, so it never queues or spawns anything.
wire_gate() { call "$API" POST /v1/match/join "$ENV_NAME" "$LOCK_BUILD" "$PLATFORM" "$1" "$ZERO_FP" '{"mode":"quickplay"}' "$SESSION_TOKEN"; }
app_route() { call "$API" POST /v1/session "$ENV_NAME" "$BUILD" "$PLATFORM" "$WIRE" - '{}' -; }

OPEN_BUILD='^401 error AUTH_REQUIRED '
LOCKED='^426 error UPDATE_REQUIRED multiplayer never - open_store$'
OPEN_WIRE='^503 error SERVER_BEHIND multiplayer after '

echo "Drill 1: a version floor above the live build -- $ENV_NAME, $API"
echo "  build $BUILD on $PLATFORM -> min_build_multiplayer.$PLATFORM $LOCK_BUILD; wire $WIRE -> min_wire $LOCK_WIRE"

fetch_live "$ORIG" || die "could not read the live $ENV_NAME document"
say "the live $ENV_NAME document is serial $(node "$OPS_DIR/doc.mjs" serial "$ORIG")"

build_gate "$BUILD"; expect "now: the multiplayer gate is open for build $BUILD" "$OPEN_BUILD"
app_route; expect "now: sign-in is open for build $BUILD" '^400 error VALIDATION '

node "$DRILL_MJS" set "$ORIG" "gates.min_build_multiplayer.$PLATFORM" "$LOCK_BUILD" >"$WORK/lock_build.json"
node "$DRILL_MJS" set "$ORIG" gates.min_wire "$LOCK_WIRE" >"$WORK/lock_wire.json"

if [ "$RUN" = 0 ]; then
  echo
  echo "PLAN: nothing published. --run would publish, in turn (publish.sh --dry-run of each follows):"
  for f in lock_build lock_wire; do
    echo "--- $f.json"
    bash "$OPS_DIR/publish.sh" "$ENV_NAME" --file "$WORK/$f.json" --dry-run ${PUBLISH_PASS[@]+"${PUBLISH_PASS[@]}"} 2>&1 \
      | grep -E 'locks builds out|^  - |^  gates|refuse' || true
  done
  echo "--- then the original document again, and the same probes as above after each."
  [ -n "$USER_NAME" ] || echo "NOTE: --user user<id> is needed for the wire step under --run."
  verdict
  exit $?
fi

[ -n "$USER_NAME" ] || die "--run needs --user user<id> (a dev account) for the wire step"
sign_in "$API" "$ENV_NAME" "$USER_NAME" || exit 1
wire_gate "$WIRE"; expect "now: the wire gate is open for wire $WIRE (signed in)" "$OPEN_WIRE"
[ "$DRILL_FAILED" = 0 ] || { fail "the gates are not open before the drill: nothing published"; exit 1; }

echo "--- step 1: min_build_multiplayer.$PLATFORM = $LOCK_BUILD"
RESTORE_NEEDED=1
publish "$WORK/lock_build.json" --confirm-lock || { fail "publish of the build floor"; exit 1; }
fault after-build-publish
wait_for_reply "$WAIT_SEC" '^426 ' build_gate "$BUILD" || true
expect "step 1: build $BUILD is refused at the multiplayer gate" "$LOCKED"
build_gate "$LOCK_BUILD"; expect "step 1: build $LOCK_BUILD passes the multiplayer gate" "$OPEN_BUILD"
app_route; expect "step 1: build $BUILD can still sign in (scope multiplayer only; single player unaffected)" '^400 error VALIDATION '
hold "step 1: build $BUILD is below the multiplayer floor"

echo "--- step 2: min_wire = $LOCK_WIRE (the build floor back as it was)"
publish "$WORK/lock_wire.json" --confirm-lock || { fail "publish of the wire floor"; exit 1; }
fault after-wire-publish
wait_for_reply "$WAIT_SEC" '^426 ' wire_gate "$WIRE" || true
expect "step 2: wire $WIRE is refused at the wire floor" "$LOCKED"
wire_gate "$LOCK_WIRE"; expect "step 2: wire $LOCK_WIRE passes the wire floor" "$OPEN_WIRE"
build_gate "$BUILD"; expect "step 2: build $BUILD passes the build gate again" "$OPEN_BUILD"
hold "step 2: wire $WIRE is below min_wire"

echo "--- step 3: the original document again"
publish "$ORIG" || { fail "republishing the original document"; exit 1; }
RESTORE_NEEDED=0
wait_for_reply "$WAIT_SEC" '^503 ' wire_gate "$WIRE" || true
expect "step 3: the wire floor is lifted for wire $WIRE" "$OPEN_WIRE"
build_gate "$BUILD"; expect "step 3: the multiplayer gate is open for build $BUILD" "$OPEN_BUILD"
hold "step 3: the original document is back"

verdict
