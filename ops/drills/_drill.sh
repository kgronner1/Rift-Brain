# shellcheck shell=bash source-path=SCRIPTDIR disable=SC2034 # its variables are set here for the drills that source it
# Shared by the release drills (spec M8): drill1_version_floor.sh, drill2_server_behind.sh, drill7_env_isolation.sh.
# Sourced from bash, never from zsh. Wobble Planet's docs/release-drills.md says when and how to run each.
#
# Every drill defaults to PLAN: it prints what it would do and runs only the probes that change nothing (no publish,
# no sign-in). --run does the drill. Each check prints "DRILL<n> PASS ..." or "DRILL<n> FAIL ...", and the last line is
# "DRILL<n> RESULT: PASS" or "DRILL<n> RESULT: FAIL"; the exit status is 0 only for a pass.
#
# A drill that signs in uses a dev account (--user user<id>; the password is RJ_DRILL_PASSWORD, default the scrubbed
# dev password riftjumpers-dev). Its first sign-in issues one device credential, which is kept in
# $RJ_DRILL_STATE_DIR/drill.<env>.<user>.credential (default ~/.config/rift-jumpers, chmod 600) and restored from on
# every later run, so repeated drills never pile credentials up in the dev database.

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DRILL_DIR/../.." && pwd)"
# shellcheck source=../../infra/stacks.env
. "$REPO_DIR/infra/stacks.env"
DRILL_MJS="$DRILL_DIR/drill.mjs"

DRILL_NAME="${DRILL_NAME:-DRILL}"
DRILL_FAILED=0
DRILL_CHECKS=0
DRILL_INSTALL="drill-$(basename "$0" .sh)-$$"
DRILL_STATE_DIR="${RJ_DRILL_STATE_DIR:-$HOME/.config/rift-jumpers}"
# The local stand-in for the config server's certificate (ops/drills/test/drills_local.sh); empty on the real thing.
CURL_TLS=()
[ -z "${RJ_DRILL_CACERT:-}" ] || CURL_TLS=(--cacert "$RJ_DRILL_CACERT")

say() { echo "[$DRILL_NAME] $*"; }
pass() { DRILL_CHECKS=$((DRILL_CHECKS + 1)); echo "$DRILL_NAME PASS  $*"; }
fail() { DRILL_CHECKS=$((DRILL_CHECKS + 1)); DRILL_FAILED=1; echo "$DRILL_NAME FAIL  $*"; }
die() { echo "$(basename "$0"): $*" >&2; exit 2; }

# Prints the verdict and returns its status. A drill that ran no check at all did not pass.
verdict() {
  VERDICT_PRINTED=1
  if [ "$DRILL_FAILED" = 0 ] && [ "$DRILL_CHECKS" -gt 0 ]; then
    echo "$DRILL_NAME RESULT: PASS ($DRILL_CHECKS checks)"
    return 0
  fi
  [ "$DRILL_CHECKS" -gt 0 ] || echo "$DRILL_NAME FAIL  no check ran"
  echo "$DRILL_NAME RESULT: FAIL"
  return 1
}

api_for_env() {
  case "$1" in
    dev) echo "https://api-dev.$RJ_DOMAIN" ;;
    alpha) echo "https://api.$RJ_DOMAIN" ;;
    *) die "no API host for env $1" ;;
  esac
}

config_url_for_env() {
  echo "${RJ_DRILL_CONFIG_BASE:-https://$RJ_CONFIG_HOST}/$1/client.v1.json"
}

# The wire VERSION and FINGERPRINT of the Wobble Planet checkout beside this one (or RJ_WOBBLE_PLANET).
wp_dir() {
  echo "${RJ_WOBBLE_PLANET:-$(cd "$REPO_DIR/.." && pwd)/Wobble Planet}"
}
wp_wire() {
  sed -nE 's/^const VERSION := ([0-9]+).*/\1/p' "$(wp_dir)/Scripts/Net/WireProtocol.gd" 2>/dev/null || true
}
wp_fp() {
  sed -nE 's/^const FINGERPRINT := "([0-9a-f]+)".*/\1/p' "$(wp_dir)/Scripts/Net/WireProtocol.gd" 2>/dev/null || true
}

# call <api> <METHOD> <path> <env header> <build> <platform> <wire|-> <fp|-> <json body|-> <bearer|->
# Sets REPLY_BODY and REPLY_LINE ("<status> <result> <code> <scope> <retry kind> <after_ms> <action>", drill.mjs).
# A request that never got an answer is status 000, result "unparsed".
call() {
  local api="$1" method="$2" path="$3" env="$4" build="$5" platform="$6" wire="$7" fp="$8" body="$9" bearer="${10}"
  local args=(-sS --max-time 15 -o - -w '\n%{http_code}' -X "$method" "$api$path"
    -H 'Content-Type: application/json' -H 'X-RJ-Api: 1' -H "X-RJ-Env: $env" -H "X-RJ-Build: $build"
    -H "X-RJ-Platform: $platform" -H "X-RJ-Install: $DRILL_INSTALL")
  [ "$wire" = - ] || args+=(-H "X-RJ-Wire: $wire")
  [ "$fp" = - ] || args+=(-H "X-RJ-Wire-Fp: $fp")
  [ "$body" = - ] || args+=(--data "$body")
  [ "$bearer" = - ] || args+=(-H "Authorization: Bearer $bearer")
  local out status
  out="$(curl "${args[@]}" 2>/dev/null)" || out=$'\n000'
  status="${out##*$'\n'}"
  REPLY_BODY="${out%$'\n'*}"
  REPLY_LINE="$(printf '%s' "$REPLY_BODY" | node "$DRILL_MJS" envelope "$status")"
}

# expect <label> <ERE over REPLY_LINE>: a PASS or a FAIL line for the last call.
expect() {
  if [[ "$REPLY_LINE" =~ $2 ]]; then pass "$1  [$REPLY_LINE]"; else fail "$1  [got: $REPLY_LINE]"; fi
}

# wait_for_reply <seconds> <ERE> <probe> [args...]: runs the probe (a function that ends in a call) every 5 s until
# its REPLY_LINE matches. The brain re-reads its config every 30 s, after the publish's own CloudFront wait, so a gate
# moves within about a minute.
wait_for_reply() {
  local secs="$1" re="$2" t0
  shift 2
  t0="$(date +%s)"
  while :; do
    "$@"
    [[ "$REPLY_LINE" =~ $re ]] && { say "  (after $(( $(date +%s) - t0 )) s)"; return 0; }
    [ $(( $(date +%s) - t0 )) -lt "$secs" ] || return 1
    sleep 5
  done
}

credential_file() {
  echo "$DRILL_STATE_DIR/drill.$1.$2.credential"
}

# sign_in <api> <env> <user>: sets SESSION_UID, SESSION_TOKEN and CREDENTIAL_JSON ({"user_id","token"}), restoring
# from the kept credential when there is one and signing in with the password (which issues one) only when there is
# not, or the kept one no longer works. Returns 1, with a FAIL line, when neither works.
sign_in() {
  local api="$1" env="$2" user="$3" file reply
  file="$(credential_file "$env" "$user")"
  SESSION_UID=""; SESSION_TOKEN=""; CREDENTIAL_JSON=""
  if [ -s "$file" ]; then
    CREDENTIAL_JSON="$(cat "$file")"
    call "$api" POST /v1/session "$env" 999999999 android - - "{\"credential\":$CREDENTIAL_JSON}" -
    if reply="$(printf '%s' "$REPLY_BODY" | node "$DRILL_MJS" session)"; then
      SESSION_UID="${reply%% *}"; SESSION_TOKEN="${reply#* }"
      say "signed in to $env as $user (user $SESSION_UID) by restoring the kept credential"
      return 0
    fi
    say "the kept credential for $user no longer restores ($REPLY_LINE); signing in with the password"
  fi
  local body
  body="$(node -e 'console.log(JSON.stringify({login: {id: process.argv[1], password: process.argv[2]}}))' \
    "$user" "${RJ_DRILL_PASSWORD:-riftjumpers-dev}")"
  call "$api" POST /v1/session "$env" 999999999 android - - "$body" -
  if ! reply="$(printf '%s' "$REPLY_BODY" | node "$DRILL_MJS" session)"; then
    fail "sign in to $env as $user  [got: $REPLY_LINE]"
    return 1
  fi
  SESSION_UID="${reply%% *}"; SESSION_TOKEN="${reply#* }"
  CREDENTIAL_JSON="$(printf '%s' "$REPLY_BODY" | node "$DRILL_MJS" credential)" || CREDENTIAL_JSON=""
  if [ -n "$CREDENTIAL_JSON" ]; then
    mkdir -p "$DRILL_STATE_DIR"
    ( umask 077; printf '%s\n' "$CREDENTIAL_JSON" >"$file" )
    say "signed in to $env as $user (user $SESSION_UID) with the password; its credential is kept in $file"
  fi
  return 0
}
