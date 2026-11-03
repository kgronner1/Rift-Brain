#!/usr/bin/env bash
# Publishes the invite link site (RJ 458; Wobble Planet specs/invite-links.md, 5) to https://join.<domain>/.
#
#   bash ops/join/publish.sh --dry-run     build it, and print every file, its type and the commands; write nothing
#   bash ops/join/publish.sh               build, upload, invalidate, fetch back
#   --keep <dir>                           also leave the built site in <dir> (to look at it)
#
# Steps, each of which stops the publish on failure:
#   1. web/join/build.mjs builds the site from web/join/site.json; a malformed value stops it. A value not known yet
#      (null) is listed and left out: no fingerprint, an empty iOS association, a coming-soon line.
#   2. rj-edge's outputs name the bucket and the distribution (read-only). A dry run goes on without them.
#   3. every file uploaded with put-object and the content type and Cache-Control build.mjs gives it: application/json
#      for both .well-known files (apple-app-site-association has no extension, so nothing could guess it). The fonts
#      first and index.html last, so the page never names a file that is not there yet.
#   4. a CloudFront invalidation of /*, waited for
#   5. fetched back over HTTPS: both .well-known files byte for byte and as application/json, and an invite path
#      (/dev/<id>) answered with the page
#
# A file dropped from web/join stays in the bucket until removed by hand (nothing here deletes). Safe to re-run.
# Reads infra/stacks.env; AWS through --profile $RJ_AWS_PROFILE. Needs node (20+), the AWS CLI and curl.
set -euo pipefail

JOIN_OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$JOIN_OPS_DIR/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../../infra/stacks.env
. "$REPO_DIR/infra/stacks.env"

die() { echo "publish.sh: $*" >&2; exit 1; }
note() { echo "[join/publish] $*"; }
aws_rj() { aws --profile "$RJ_AWS_PROFILE" --no-cli-pager "$@"; }

DRY_RUN=0
KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --keep) KEEP="${2:?--keep needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown argument $1 (--help)" ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-join-publish.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SITE="$WORK/site"

# --- 1. build -----------------------------------------------------------------------------------------------------
note "1/5 build from web/join/site.json"
node "$REPO_DIR/web/join/build.mjs" --out "$SITE" >"$WORK/build.out" || die "the build failed (above)"
FILES=()
TYPES=()
CACHES=()
while read -r kind key type cache; do
  case "$kind" in
    FILE) FILES+=("$key"); TYPES+=("${type//;/; }"); CACHES+=("${cache//,/, }") ;;
    UNKNOWN) note "not known yet, left out: $key" ;;
  esac
done <"$WORK/build.out"
[ "${#FILES[@]}" -gt 0 ] || die "the build listed no files"
if [ -n "$KEEP" ]; then
  mkdir -p "$KEEP"
  cp -R "$SITE/." "$KEEP/"
  note "the built site is also in $KEEP"
fi

# Upload order: assets/, then .well-known/ and robots.txt, then index.html.
ORDER=()
for prefix in assets/ .well-known/ robots.txt index.html; do
  for i in "${!FILES[@]}"; do
    case "${FILES[$i]}" in "$prefix"*) ORDER+=("$i") ;; esac
  done
done
[ "${#ORDER[@]}" = "${#FILES[@]}" ] || die "the build made a file this script does not know how to order: ${FILES[*]}"

# --- 2. where -----------------------------------------------------------------------------------------------------
BUCKET=""
DIST=""
# shellcheck disable=SC2016 # a JMESPath query, not shell
if out="$(aws_rj cloudformation describe-stacks --region "$RJ_EDGE_REGION" --stack-name "$RJ_EDGE_STACK" \
    --query 'Stacks[0].Outputs[?OutputKey==`JoinBucketName` || OutputKey==`JoinDistributionId`].[OutputKey,OutputValue]' \
    --output text 2>&1)"; then
  BUCKET="$(awk '$1=="JoinBucketName"{print $2}' <<<"$out")"
  DIST="$(awk '$1=="JoinDistributionId"{print $2}' <<<"$out")"
fi
if [ -z "$BUCKET" ] || [ -z "$DIST" ]; then
  [ "$DRY_RUN" = 1 ] || die "stack $RJ_EDGE_STACK ($RJ_EDGE_REGION) has no JoinBucketName/JoinDistributionId outputs: deploy it first (bash infra/deploy_stacks.sh --edge-only --apply). ${out:-}"
  note "WARNING: no join outputs on stack $RJ_EDGE_STACK yet (deployed? infra/deploy_stacks.sh --edge-only); the dry run names them <JoinBucketName> and <JoinDistributionId>"
  BUCKET="${BUCKET:-<JoinBucketName>}"
  DIST="${DIST:-<JoinDistributionId>}"
fi
note "2/5 s3://$BUCKET behind CloudFront $DIST, https://$RJ_JOIN_HOST/"

# --- 3. upload ----------------------------------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  note "DRY RUN: nothing written. It would run:"
  for i in "${ORDER[@]}"; do
    printf "  aws s3api put-object --bucket %s --key %s --body <%s> --content-type '%s' --cache-control '%s'\n" \
      "$BUCKET" "${FILES[$i]}" "${FILES[$i]}" "${TYPES[$i]}" "${CACHES[$i]}"
  done
  echo "  aws cloudfront create-invalidation --distribution-id $DIST --paths '/*'"
  echo "  aws cloudfront wait invalidation-completed ..."
  echo "  curl https://$RJ_JOIN_HOST/.well-known/assetlinks.json, /.well-known/apple-app-site-association, /dev/<id>   (and compare)"
  exit 0
fi

note "3/5 upload ${#FILES[@]} files"
for i in "${ORDER[@]}"; do
  aws_rj s3api put-object --region "$RJ_EDGE_REGION" --bucket "$BUCKET" --key "${FILES[$i]}" --body "$SITE/${FILES[$i]}" \
    --content-type "${TYPES[$i]}" --cache-control "${CACHES[$i]}" --query VersionId --output text >/dev/null \
    || die "uploading ${FILES[$i]} failed"
  note "  ${FILES[$i]}  ${TYPES[$i]}  ${CACHES[$i]}"
done

# --- 4. invalidate ------------------------------------------------------------------------------------------------
note "4/5 CloudFront invalidation of /*"
INV="$(aws_rj cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' --query Invalidation.Id --output text)"
aws_rj cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"

# --- 5. fetch back ------------------------------------------------------------------------------------------------
note "5/5 fetch back from https://$RJ_JOIN_HOST/"
# fetch <path> <the file it must equal> <the type it must have>
fetch() {
  local path="$1" want="$2" type="$3" got="" try
  for try in 1 2 3 4 5 6; do
    if got="$(curl -fsS --max-time 10 -o "$WORK/fetched" -w '%{content_type}' "https://$RJ_JOIN_HOST$path")" \
      && [ "${got%%;*}" = "$type" ] && cmp -s "$WORK/fetched" "$want"; then
      note "  $path: $got"
      return 0
    fi
    # The invalidation has completed, but an edge can lag it by seconds. (RJ_JOIN_FETCH_WAIT: tests.)
    [ "$try" = 6 ] || sleep "${RJ_JOIN_FETCH_WAIT:-10}"
  done
  die "https://$RJ_JOIN_HOST$path does not serve what was uploaded (type ${got:-none}, want $type) after a minute; check CloudFront"
}
fetch /.well-known/assetlinks.json "$SITE/.well-known/assetlinks.json" application/json
fetch /.well-known/apple-app-site-association "$SITE/.well-known/apple-app-site-association" application/json
fetch /dev/publishchk "$SITE/index.html" text/html
note "published https://$RJ_JOIN_HOST/"
if ! git -C "$REPO_DIR" diff --quiet HEAD -- web/join 2>/dev/null; then
  echo "WARNING: web/join has uncommitted changes. Commit them now: the source in git must match what is live."
fi
