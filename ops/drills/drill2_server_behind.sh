#!/usr/bin/env bash
# Release drill 2 (spec M8): a client newer than the server. Dev only. Changes nothing on the brain.
#
#   bash ops/drills/drill2_server_behind.sh [--user user<id>] [options]          PLAN: the unsigned probes only
#   bash ops/drills/drill2_server_behind.sh --user user<id> --run [options]      the drill
#
#   --wire W         the newest wire deployed on dev (default: Wobble Planet's Scripts/Net/WireProtocol.gd)
#   --user user<id>  a dev account: match/join is behind a session
#   --api URL        the brain (default https://api-dev.riftjumpers.space)
#
# The HTTP side of the drill, signed in, with a fingerprint no deployed server has (so a join can never be ok, and
# never queues or spawns anything):
#   - a join on wire W+1 (newer than every server) answers SERVER_BEHIND: 503, retry after 300000 ms, scope
#     multiplayer, action dismiss -- the client waits five minutes rather than retrying in a loop;
#   - a join on wire W with a sibling fingerprint (a branch build of the deployed wire) answers SERVER_BEHIND too;
#   - controls, so the two above cannot pass by accident: unsigned, the same join is AUTH_REQUIRED; signed in with no
#     wire header, it is UPDATE_REQUIRED (the session was accepted and the route check ran).
# A join releases the drill account from any lobby or queue it was in: use an account nobody is playing on.
#
# The phone's half (a build with a bumped wire, or --withdraw the newest wire on dev) is Wobble Planet's
# docs/release-drills.md, drill 2.
set -euo pipefail

DRILL_NAME=DRILL2
# shellcheck source-path=SCRIPTDIR source=_drill.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_drill.sh"

ENV_NAME=dev
WIRE=""
USER_NAME=""
API=""
RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --wire) WIRE="${2:?}"; shift 2 ;;
    --user) USER_NAME="${2:?}"; shift 2 ;;
    --api) API="${2:?}"; shift 2 ;;
    --run) RUN=1; shift ;;
    --env) [ "${2:-}" = dev ] || die "drill 2 runs against dev only"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

WIRE="${WIRE:-$(wp_wire)}"
[[ "$WIRE" =~ ^[0-9]+$ ]] || die "--wire <W> is required (no Wobble Planet checkout at $(wp_dir) to read it from)"
API="${API:-$(api_for_env "$ENV_NAME")}"
NEWER=$((WIRE + 1))
ZERO_FP=0000000000000000
BUILD=999999999
JOIN='{"mode":"quickplay"}'

BEHIND='^503 error SERVER_BEHIND multiplayer after 300000 dismiss$'

echo "Drill 2: a client newer than the server -- $ENV_NAME, $API, deployed wire $WIRE"

call "$API" POST /v1/match/join "$ENV_NAME" "$BUILD" android "$NEWER" "$ZERO_FP" "$JOIN" -
expect "control: an unsigned join on wire $NEWER is AUTH_REQUIRED" '^401 error AUTH_REQUIRED '

if [ "$RUN" = 0 ]; then
  echo
  echo "PLAN: --run --user user<id> signs in and asks POST /v1/match/join for quickplay on wire $NEWER and on wire"
  echo "$WIRE with fingerprint $ZERO_FP, expecting SERVER_BEHIND with a five-minute retry from both."
  verdict
  exit $?
fi

[ -n "$USER_NAME" ] || die "--run needs --user user<id> (a dev account): match/join is behind a session"
sign_in "$API" "$ENV_NAME" "$USER_NAME" || { verdict; exit 1; }

call "$API" POST /v1/match/join "$ENV_NAME" "$BUILD" android - - "$JOIN" "$SESSION_TOKEN"
expect "control: signed in, a join with no wire is UPDATE_REQUIRED (the session is accepted)" \
  '^426 error UPDATE_REQUIRED multiplayer never '

call "$API" POST /v1/match/join "$ENV_NAME" "$BUILD" android "$NEWER" "$ZERO_FP" "$JOIN" "$SESSION_TOKEN"
expect "a join on wire $NEWER (newer than the servers) is SERVER_BEHIND, retry in 5 min" "$BEHIND"

call "$API" POST /v1/match/join "$ENV_NAME" "$BUILD" android "$WIRE" "$ZERO_FP" "$JOIN" "$SESSION_TOKEN"
expect "a join on wire $WIRE with a fingerprint no server has is SERVER_BEHIND, retry in 5 min" "$BEHIND"

verdict
