#!/usr/bin/env bash
# Republishes an earlier remote config document under a new serial (spec 4.5, M1), and prints the diff.
#
#   bash ops/config/rollback.sh <dev|alpha|prod> [<s3 version id>] [options]
#
#   <s3 version id>       the body to bring back (default: the one before the live one); --list shows them
#   --list                list the published versions, newest first, and change nothing
#   --dry-run, --confirm-lock, --skip-client-check, --local-root <dir>
#                         as publish.sh: the earlier body goes through every one of publish.sh's checks
#
# A rollback never rewrites history: it uploads the old body as a new version with the next serial, because a
# client ignores a document whose serial is below the one it already holds. Afterwards, make the source in git
# (config/<env>.client.v1.json) match, and commit it.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=_lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

ENV_NAME=""
VERSION_ID=""
LIST=0
LOCAL_ROOT=""
PASS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1; shift ;;
    --dry-run|--confirm-lock|--skip-client-check) PASS+=("$1"); shift ;;
    --local-root) LOCAL_ROOT="${2:?--local-root needs a directory}"; PASS+=(--local-root "$2"); shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    -*) die "unknown option $1 (--help)" ;;
    *)
      if [ -z "$ENV_NAME" ]; then ENV_NAME="$1"
      elif [ -z "$VERSION_ID" ]; then VERSION_ID="$1"
      else die "too many arguments"
      fi
      shift ;;
  esac
done

case "$ENV_NAME" in dev|alpha|prod) ;; *) die "usage: rollback.sh <dev|alpha|prod> [<s3 version id>] [options] (--help)" ;; esac
KEY="$(config_key "$ENV_NAME")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-rollback.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
VERSIONS="$WORK/versions.tsv"
BODY="$WORK/rollback.$ENV_NAME.client.v1.json"

# VERSIONS: "<version id>\t<when>", newest first.
if [ -n "$LOCAL_ROOT" ]; then
  dir="$(local_versions_dir "$ENV_NAME")"
  [ -d "$dir" ] || die "nothing published under $LOCAL_ROOT/$ENV_NAME"
  find "$dir" -name '*.json' -exec basename {} .json \; | sort -rn | while read -r s; do
    printf '%s\tserial %s\n' "$s" "$s"
  done >"$VERSIONS"
else
  edge_outputs
  aws_rj s3api list-object-versions --region "$RJ_EDGE_REGION" --bucket "$CONFIG_BUCKET" --prefix "$KEY" \
    --query "Versions[?Key=='$KEY'].[VersionId,LastModified]" --output text \
    | sort -t$'\t' -k2,2r >"$VERSIONS"
fi
[ -s "$VERSIONS" ] || die "nothing is published for $ENV_NAME"

if [ "$LIST" = 1 ]; then
  echo "Published versions of $KEY, newest (live) first:"
  sed 's/^/  /' "$VERSIONS"
  exit 0
fi

LIVE_ID="$(head -n 1 "$VERSIONS" | cut -f1)"
if [ -z "$VERSION_ID" ]; then
  VERSION_ID="$(sed -n 2p "$VERSIONS" | cut -f1)"
  [ -n "$VERSION_ID" ] || die "only one version is published; there is nothing earlier to roll back to"
fi
cut -f1 "$VERSIONS" | grep -qxF "$VERSION_ID" || die "no version $VERSION_ID of $KEY (--list shows them)"
[ "$VERSION_ID" != "$LIVE_ID" ] || die "$VERSION_ID is the live version already"

if [ -n "$LOCAL_ROOT" ]; then
  cp "$(local_versions_dir "$ENV_NAME")/$VERSION_ID.json" "$BODY"
else
  aws_rj s3api get-object --region "$RJ_EDGE_REGION" --bucket "$CONFIG_BUCKET" --key "$KEY" \
    --version-id "$VERSION_ID" "$BODY" >/dev/null
fi
note "rolling $ENV_NAME back to version $VERSION_ID (serial $(node "$DOC_MJS" serial "$BODY")), under a new serial"

bash "$OPS_DIR/publish.sh" "$ENV_NAME" --file "$BODY" ${PASS[@]+"${PASS[@]}"}

SOURCE="$REPO_DIR/config/$ENV_NAME.client.v1.json"
if [ -f "$SOURCE" ]; then
  echo "The source in git against what was rolled back to (make the source match, and commit it):"
  node "$DOC_MJS" diff "$SOURCE" "$BODY" | sed 's/^/  /'
fi
