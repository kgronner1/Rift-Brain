# shellcheck shell=bash source-path=SCRIPTDIR
# Shared by publish.sh and rollback.sh. Sourced from bash, never from zsh.

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$OPS_DIR/../.." && pwd)"
# shellcheck source=../../infra/stacks.env
. "$REPO_DIR/infra/stacks.env"
# shellcheck disable=SC2034 # used by the scripts that source this
DOC_MJS="$OPS_DIR/doc.mjs"

die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

note() {
  echo "[$(basename "$0" .sh)] $*"
}

config_key() {
  echo "$1/client.v1.json"
}

aws_rj() {
  aws --profile "$RJ_AWS_PROFILE" "$@"
}

# Sets CONFIG_BUCKET and CONFIG_DISTRIBUTION from rj-edge's outputs (read-only).
edge_outputs() {
  local out
  # shellcheck disable=SC2016 # a JMESPath query, not shell
  out="$(aws_rj cloudformation describe-stacks --region "$RJ_EDGE_REGION" --stack-name "$RJ_EDGE_STACK" \
    --query 'Stacks[0].Outputs[?OutputKey==`BucketName` || OutputKey==`DistributionId`].[OutputKey,OutputValue]' \
    --output text 2>&1)" || die "cannot read stack $RJ_EDGE_STACK in $RJ_EDGE_REGION (deployed yet? infra/deploy_stacks.sh): $out"
  CONFIG_BUCKET="$(awk '$1=="BucketName"{print $2}' <<<"$out")"
  CONFIG_DISTRIBUTION="$(awk '$1=="DistributionId"{print $2}' <<<"$out")"
  [ -n "$CONFIG_BUCKET" ] && [ -n "$CONFIG_DISTRIBUTION" ] || die "stack $RJ_EDGE_STACK has no BucketName/DistributionId outputs"
}

# A local stand-in for the bucket (--local-root): <root>/<env>/client.v1.json is the live object, and every
# publish is also kept as <root>/<env>/.versions/<serial>.json, newest serial = newest version.
local_live() {
  echo "$LOCAL_ROOT/$(config_key "$1")"
}

local_versions_dir() {
  echo "$LOCAL_ROOT/$1/.versions"
}
