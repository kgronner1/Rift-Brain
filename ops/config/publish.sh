#!/usr/bin/env bash
# Publishes a remote config document (spec 4.5, M1) to https://config.<domain>/<env>/client.v1.json.
#
#   bash ops/config/publish.sh <dev|alpha|prod> [options]
#
#   --file <path>         the document to publish (default config/<env>.client.v1.json)
#   --dry-run             do every check and print what would be published, and the commands; write nothing
#   --confirm-lock        allow a change that locks builds out (a raised min_build*, min_wire, or app maintenance)
#   --skip-client-check   publish on validate.mjs alone, without the client's own parser (until M2 lands it)
#   --live <path>         with --dry-run: compare against this file instead of the live object
#   --local-root <dir>    publish into a directory instead of S3 + CloudFront (tests; no AWS call at all)
#
# Steps, each of which stops the publish on failure:
#   1. validate.mjs: every field, type and clamp, and env = <env>
#   2. the client's own parser (Wobble Planet's check_remote_config.gd) rejects no field
#   3. the lock guard: a change that locks builds out needs --confirm-lock, and says which builds
#   4. serial = live serial + 1, published_at = now
#   5. upload, Cache-Control: public, max-age=60, conditional on the live object not having changed meanwhile
#   6. CloudFront invalidation, waited for
#   7. fetch it back over HTTPS and compare
#
# Safe to re-run: a re-run publishes the same content under the next serial.
# An emergency publish from a working tree must be committed straight after; the script says so.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=_lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

ENV_NAME=""
FILE=""
DRY_RUN=0
CONFIRM_LOCK=0
SKIP_CLIENT_CHECK=0
LIVE_FILE=""
LOCAL_ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:?--file needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --confirm-lock) CONFIRM_LOCK=1; shift ;;
    --skip-client-check) SKIP_CLIENT_CHECK=1; shift ;;
    --live) LIVE_FILE="${2:?--live needs a path}"; shift 2 ;;
    --local-root) LOCAL_ROOT="${2:?--local-root needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    -*) die "unknown option $1 (--help)" ;;
    *) [ -z "$ENV_NAME" ] || die "one environment at a time"; ENV_NAME="$1"; shift ;;
  esac
done

case "$ENV_NAME" in dev|alpha|prod) ;; *) die "usage: publish.sh <dev|alpha|prod> [options] (--help)" ;; esac
[ -z "$LIVE_FILE" ] || [ "$DRY_RUN" = 1 ] || die "--live is for --dry-run only: a real publish always compares against the live object"
FILE="${FILE:-$REPO_DIR/config/$ENV_NAME.client.v1.json}"
[ -f "$FILE" ] || die "no such file: $FILE"
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
KEY="$(config_key "$ENV_NAME")"
URL="https://$RJ_CONFIG_HOST/$KEY"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-publish.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- 1. validate.mjs ---------------------------------------------------------------------------------------------
note "1/7 validate.mjs"
node "$OPS_DIR/validate.mjs" "$FILE" --env "$ENV_NAME"

# --- 2. the client's own parser ----------------------------------------------------------------------------------
note "2/7 the client's parser"
WP_DIR="${RJ_WOBBLE_PLANET:-$(cd "$REPO_DIR/.." && pwd)/Wobble Planet}"
CHECK_GD="Tools/harness/check_remote_config.gd"
if [ "$SKIP_CLIENT_CHECK" = 1 ]; then
  note "SKIPPED (--skip-client-check): only validate.mjs has read this document"
elif [ ! -f "$WP_DIR/$CHECK_GD" ]; then
  die "$WP_DIR/$CHECK_GD does not exist. It is M2's (the client's remote config parser); until it lands, re-run with --skip-client-check. Set RJ_WOBBLE_PLANET if the checkout is elsewhere."
else
  CHECK_LOG="$WORK/check_remote_config.log"
  # A subshell: _common.sh installs traps and job state of its own. The harness runs without set -e (smoke.sh is
  # set -uo pipefail): under -e, a non-zero status inside its EXIT trap's cleanup replaced the checker's own 0.
  if ! (
    set +e
    # shellcheck source=/dev/null
    . "$WP_DIR/Tools/harness/_common.sh"
    harness_spawn_godot check_remote_config "$CHECK_LOG" 120 --headless --path "$WP_DIR" --net_env=offline \
      --script "res://$CHECK_GD" --file="$FILE"
    harness_wait_jobs
    exit "$(harness_job_rc check_remote_config)"
  ); then
    grep -E '\[CONFIG\]|ERROR' "$CHECK_LOG" >&2 || tail -n 40 "$CHECK_LOG" >&2
    die "the client's parser rejected $FILE (log: kept above)"
  fi
  grep -E '\[CONFIG\]' "$CHECK_LOG" || true
  note "the client's parser accepts every field"
fi

# --- the live document -------------------------------------------------------------------------------------------
LIVE="$WORK/live.json"
LIVE_ETAG=""
LIVE_KNOWN=1
if [ -n "$LIVE_FILE" ]; then
  cp "$LIVE_FILE" "$LIVE"
  note "comparing against $LIVE_FILE (--live) instead of the live object"
elif [ -n "$LOCAL_ROOT" ]; then
  if [ -f "$(local_live "$ENV_NAME")" ]; then cp "$(local_live "$ENV_NAME")" "$LIVE"; else : >"$LIVE"; fi
else
  edge_outputs
  if ! out="$(aws_rj s3api get-object --region "$RJ_EDGE_REGION" --bucket "$CONFIG_BUCKET" --key "$KEY" "$LIVE" \
      --query ETag --output text 2>&1)"; then
    if grep -q 'NoSuchKey' <<<"$out"; then
      : >"$LIVE"
      note "nothing is published at s3://$CONFIG_BUCKET/$KEY yet: this is the first publish"
    elif [ "$DRY_RUN" = 1 ]; then
      : >"$LIVE"
      LIVE_KNOWN=0
      note "WARNING: could not read the live object ($out); the dry run compares against nothing"
    else
      die "could not read s3://$CONFIG_BUCKET/$KEY: $out"
    fi
  else
    LIVE_ETAG="$out"
  fi
fi

# --- 3. the lock guard -------------------------------------------------------------------------------------------
note "3/7 lock guard"
set +e
LOCKS="$(node "$DOC_MJS" locks "$LIVE" "$FILE")"
LOCK_RC=$?
set -e
case "$LOCK_RC" in
  0) note "this change locks no build out" ;;
  3)
    echo "This change locks builds out:"
    while IFS= read -r line; do echo "  - $line"; done <<<"$LOCKS"
    if [ "$CONFIRM_LOCK" = 1 ]; then
      note "--confirm-lock given: going ahead"
    elif [ "$DRY_RUN" = 1 ]; then
      note "a real publish would refuse this without --confirm-lock"
    else
      die "refused: re-run with --confirm-lock if these builds really should be locked out"
    fi
    ;;
  *) die "the lock guard failed (doc.mjs locks exited $LOCK_RC)" ;;
esac

# --- 4. serial and published_at ----------------------------------------------------------------------------------
LIVE_SERIAL="$(node "$DOC_MJS" serial "$LIVE")"
SERIAL=$((LIVE_SERIAL + 1))
STAMPED="$WORK/client.v1.json"
node "$DOC_MJS" stamp "$FILE" --serial "$SERIAL" >"$STAMPED"
node "$OPS_DIR/validate.mjs" "$STAMPED" --env "$ENV_NAME" >/dev/null
note "4/7 serial $LIVE_SERIAL -> $SERIAL, published_at $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).published_at)' "$STAMPED")"

echo "Changes from the live document:"
node "$DOC_MJS" diff "$LIVE" "$STAMPED" | sed 's/^/  /'

if [ "$DRY_RUN" = 1 ]; then
  KEEP="${TMPDIR:-/tmp}/rj-publish-$ENV_NAME-dry-run.json"
  cp "$STAMPED" "$KEEP"
  [ "$LIVE_KNOWN" = 1 ] || note "(the serial above assumes nothing is live)"
  note "DRY RUN: nothing written. The document that would be published: $KEEP"
  if [ -n "$LOCAL_ROOT" ]; then
    note "would write $(local_live "$ENV_NAME") and $(local_versions_dir "$ENV_NAME")/$SERIAL.json"
  else
    echo "Would run:"
    echo "  aws s3api put-object --bucket ${CONFIG_BUCKET:-<BucketName>} --key $KEY --body <that file> \\"
    echo "    --content-type application/json --cache-control 'public, max-age=60' ${LIVE_ETAG:+--if-match $LIVE_ETAG}"
    echo "  aws cloudfront create-invalidation --distribution-id ${CONFIG_DISTRIBUTION:-<DistributionId>} --paths /$KEY"
    echo "  aws cloudfront wait invalidation-completed ..."
    echo "  curl $URL   (and compare)"
  fi
  exit 0
fi

# --- 5-7. upload, invalidate, fetch back -------------------------------------------------------------------------
if [ -n "$LOCAL_ROOT" ]; then
  mkdir -p "$(local_versions_dir "$ENV_NAME")"
  cp "$STAMPED" "$(local_versions_dir "$ENV_NAME")/$SERIAL.json"
  cp "$STAMPED" "$(local_live "$ENV_NAME")"
  note "5/7 wrote $(local_live "$ENV_NAME") (local root; no S3)"
  note "6/7 no CloudFront (local root)"
  node "$DOC_MJS" same "$(local_live "$ENV_NAME")" "$STAMPED" || die "read back a different document"
  note "7/7 read back: identical"
else
  note "5/7 upload to s3://$CONFIG_BUCKET/$KEY"
  if [ -n "$LIVE_ETAG" ]; then COND=(--if-match "$LIVE_ETAG"); else COND=(--if-none-match '*'); fi
  if ! out="$(aws_rj s3api put-object --region "$RJ_EDGE_REGION" --bucket "$CONFIG_BUCKET" --key "$KEY" \
      --body "$STAMPED" --content-type application/json --cache-control 'public, max-age=60' "${COND[@]}" \
      --query VersionId --output text 2>&1)"; then
    if grep -q 'PreconditionFailed\|ConditionalRequestConflict' <<<"$out"; then
      die "someone published $ENV_NAME while this ran (the live object changed). Nothing was written; run it again."
    fi
    die "upload failed: $out"
  fi
  note "uploaded as S3 version $out"

  note "6/7 CloudFront invalidation of /$KEY"
  INV="$(aws_rj cloudfront create-invalidation --distribution-id "$CONFIG_DISTRIBUTION" --paths "/$KEY" \
    --query Invalidation.Id --output text)"
  aws_rj cloudfront wait invalidation-completed --distribution-id "$CONFIG_DISTRIBUTION" --id "$INV"

  note "7/7 fetch back $URL"
  FETCHED="$WORK/fetched.json"
  ok=0
  # The invalidation has completed, but an edge can lag it by seconds.
  for _ in 1 2 3 4 5 6; do
    if curl -fsS --max-time 10 "$URL" -o "$FETCHED" && node "$DOC_MJS" same "$FETCHED" "$STAMPED"; then
      ok=1
      break
    fi
    sleep 10
  done
  [ "$ok" = 1 ] || die "$URL does not serve what was uploaded (serial $SERIAL) after a minute; check CloudFront"
  note "fetched back: identical"
fi

note "published $ENV_NAME serial $SERIAL"
if git -C "$REPO_DIR" ls-files --error-unmatch "$FILE" >/dev/null 2>&1; then
  if ! git -C "$REPO_DIR" diff --quiet HEAD -- "$FILE"; then
    echo "WARNING: $FILE has uncommitted changes. Commit them now: the source in git must match what is live."
  fi
else
  echo "NOTE: $FILE is not the tracked source. Make config/$ENV_NAME.client.v1.json match what is live, and commit it."
fi
