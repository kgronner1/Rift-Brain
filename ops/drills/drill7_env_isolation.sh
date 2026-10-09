#!/usr/bin/env bash
# Release drill 7 (spec M8): environment isolation. Signs in to dev; asks alpha only questions that change nothing.
#
#   bash ops/drills/drill7_env_isolation.sh [options]                        PLAN: the unsigned probes only
#   bash ops/drills/drill7_env_isolation.sh --user user<id> --run [options]  the drill
#
#   --user user<id>    a dev account (its kept credential, or the scrubbed dev password)
#   --dev-api URL      default https://api-dev.riftjumpers.space
#   --alpha-api URL    default https://api.riftjumpers.space
#
# Checks, all with build 999999999 so no floor answers first:
#   unsigned, read-only (PLAN runs these too):
#     - alpha answers a request saying X-RJ-Env: dev with ENV_MISMATCH (421), and dev one saying alpha likewise
#     - the alpha config document says env alpha and api.riftjumpers.space, the dev one env dev and api-dev
#       (a client refuses a document whose env is not its own, so a dev build given alpha's never reads it)
#   signed in to dev (--run):
#     - control: the dev session is accepted by dev (a join with no wire header is UPDATE_REQUIRED, not AUTH_*)
#     - (a) the dev session token at alpha (X-RJ-Env: alpha) is AUTH_REQUIRED: alpha's key did not sign it
#     - (b) the dev credential at alpha's POST /v1/session is AUTH_INVALID: alpha has no such credential
#     - control: the dev credential still restores a session on dev
# (a) and (b) are refused on the credentials, not misrouted: the answer is AUTH_*, never ENV_MISMATCH.
# A dev build pointed at alpha (--config_url, --api_url) is the phone's half: Wobble Planet's docs/release-drills.md,
# drill 7.
set -euo pipefail

DRILL_NAME=DRILL7
# shellcheck source-path=SCRIPTDIR source=_drill.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_drill.sh"

USER_NAME=""
DEV_API=""
ALPHA_API=""
RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="${2:?}"; shift 2 ;;
    --dev-api) DEV_API="${2:?}"; shift 2 ;;
    --alpha-api) ALPHA_API="${2:?}"; shift 2 ;;
    --run) RUN=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

DEV_API="${DEV_API:-$(api_for_env dev)}"
ALPHA_API="${ALPHA_API:-$(api_for_env alpha)}"
[ "$DEV_API" != "$ALPHA_API" ] || die "--dev-api and --alpha-api are the same brain"
BUILD=999999999
JOIN='{"mode":"quickplay"}'

echo "Drill 7: environment isolation -- dev $DEV_API, alpha $ALPHA_API"

call "$ALPHA_API" POST /v1/session dev "$BUILD" android - - '{}' -
expect "alpha refuses a dev build's request: ENV_MISMATCH" '^421 error ENV_MISMATCH app never '
call "$DEV_API" POST /v1/session alpha "$BUILD" android - - '{}' -
expect "dev refuses an alpha build's request: ENV_MISMATCH" '^421 error ENV_MISMATCH app never '
call "$ALPHA_API" POST /v1/session alpha "$BUILD" android - - '{}' -
expect "control: alpha answers its own env's request (VALIDATION for an empty body)" '^400 error VALIDATION '

check_doc() {  # check_doc <env> <api origin it must name>
  local f
  f="$(mktemp "${TMPDIR:-/tmp}/rj-drill7.XXXXXX")"
  if curl -fsS --max-time 15 ${CURL_TLS[@]+"${CURL_TLS[@]}"} "$(config_url_for_env "$1")" -o "$f" 2>/dev/null; then
    local env api
    env="$(node "$DRILL_MJS" get "$f" env)"
    api="$(node "$DRILL_MJS" get "$f" endpoints.api)"
    if [ "$env" = "$1" ] && [ "$api" = "$2" ]; then
      pass "the $1 config document says env $env, api $api"
    else
      fail "the $1 config document says env '$env', api '$api' (want $1, $2)"
    fi
  else
    fail "could not fetch $(config_url_for_env "$1")"
  fi
  rm -f "$f"
}
check_doc dev "${RJ_DRILL_DOC_API_DEV:-https://api-dev.$RJ_DOMAIN}"
check_doc alpha "${RJ_DRILL_DOC_API_ALPHA:-https://api.$RJ_DOMAIN}"

if [ "$RUN" = 0 ]; then
  echo
  echo "PLAN: --run --user user<id> signs in to dev, then sends alpha the dev session token (expects AUTH_REQUIRED)"
  echo "and the dev credential (expects AUTH_INVALID)."
  verdict
  exit $?
fi

[ -n "$USER_NAME" ] || die "--run needs --user user<id> (a dev account)"
sign_in "$DEV_API" dev "$USER_NAME" || { verdict; exit 1; }

call "$DEV_API" POST /v1/match/join dev "$BUILD" android - - "$JOIN" "$SESSION_TOKEN"
expect "control: dev accepts its own session token" '^426 error UPDATE_REQUIRED '

call "$ALPHA_API" POST /v1/match/join alpha "$BUILD" android - - "$JOIN" "$SESSION_TOKEN"
expect "(a) alpha refuses the dev session token: AUTH_REQUIRED" '^401 error AUTH_REQUIRED account never '

call "$ALPHA_API" POST /v1/session alpha "$BUILD" android - - "{\"credential\":$CREDENTIAL_JSON}" -
expect "(b) alpha refuses the dev credential: AUTH_INVALID" '^401 error AUTH_INVALID account never '

call "$DEV_API" POST /v1/session dev "$BUILD" android - - "{\"credential\":$CREDENTIAL_JSON}" -
expect "control: the dev credential still restores on dev" '^200 ok '

verdict
