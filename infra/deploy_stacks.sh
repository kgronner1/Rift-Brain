#!/usr/bin/env bash
# Deploys the two CloudFormation stacks (RJ 463, spec M1), and attaches rj-public to the box.
#
#   bash infra/deploy_stacks.sh              PLAN (the default): read-only. Validates both templates, looks up
#                                            every parameter, and prints what --apply would do. Changes nothing.
#   bash infra/deploy_stacks.sh --changeset  creates a change set per stack and prints it, without executing it.
#                                            (For a stack that does not exist yet, AWS records an empty stack in
#                                            REVIEW_IN_PROGRESS; --apply carries on from it, delete-stack drops it.)
#   bash infra/deploy_stacks.sh --apply      deploys rj-edge (us-east-1), then rj-box (us-west-1), then adds
#                                            rj-public to the box's security groups (the old group stays).
#   --edge-only / --box-only                 one stack.
#
# Idempotent: a re-run with nothing changed deploys nothing ("No changes to deploy") and attaches nothing.
#
# Reads infra/stacks.env and ~/.config/rift-jumpers/deploy.env:
#   RJ_DEPLOY_HOST   user@host of the box (its public IP is looked up from it)
#   RJ_SSH_CIDRS     space-separated, 1 to 3 CIDRs allowed to SSH (required for rj-box). Kept out of git: the
#                    repository is public. 0.0.0.0/0 is accepted, with a warning.
#   RJ_INSTANCE_ID   optional; otherwise the instance is found by its public IP.
#
# Undo (spec 7a): see infra/README.md, "Undo".
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=stacks.env
. "$INFRA_DIR/stacks.env"
DEPLOY_ENV="${RJ_DEPLOY_ENV_FILE:-$HOME/.config/rift-jumpers/deploy.env}"

MODE=plan
DO_EDGE=1
DO_BOX=1
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) MODE=plan ;;
    --changeset) MODE=changeset ;;
    --apply) MODE=apply ;;
    --edge-only) DO_BOX=0 ;;
    --box-only) DO_EDGE=0 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "deploy_stacks.sh: unknown argument $1 (--help)" >&2; exit 2 ;;
  esac
  shift
done
[ "$DO_EDGE" = 1 ] || [ "$DO_BOX" = 1 ] || { echo "deploy_stacks.sh: --edge-only and --box-only together deploy nothing" >&2; exit 2; }

die() { echo "deploy_stacks.sh: $*" >&2; exit 1; }
say() { echo "[deploy_stacks] $*"; }
aws_rj() { aws --profile "$RJ_AWS_PROFILE" "$@"; }

command -v aws >/dev/null || die "the AWS CLI is not installed"
aws_rj sts get-caller-identity --query Arn --output text >/dev/null 2>&1 \
  || die "AWS profile '$RJ_AWS_PROFILE' does not work (aws sts get-caller-identity --profile $RJ_AWS_PROFILE)"
say "mode: $MODE, as $(aws_rj sts get-caller-identity --query Arn --output text)"

if [ -f "$DEPLOY_ENV" ]; then
  # shellcheck source=/dev/null
  . "$DEPLOY_ENV"
fi

# --- templates ---------------------------------------------------------------------------------------------------
EDGE_TEMPLATE="$INFRA_DIR/cfn/rj-edge.yaml"
BOX_TEMPLATE="$INFRA_DIR/cfn/rj-box.yaml"
if [ "$DO_EDGE" = 1 ]; then
  aws_rj cloudformation validate-template --region "$RJ_EDGE_REGION" --template-body "file://$EDGE_TEMPLATE" >/dev/null
  say "rj-edge.yaml: valid"
fi
if [ "$DO_BOX" = 1 ]; then
  aws_rj cloudformation validate-template --region "$RJ_BOX_REGION" --template-body "file://$BOX_TEMPLATE" >/dev/null
  say "rj-box.yaml: valid"
fi

# --- parameters (read-only lookups) ------------------------------------------------------------------------------
ZONES="$(aws_rj route53 list-hosted-zones-by-name --dns-name "$RJ_DOMAIN" \
  --query "HostedZones[?Name=='$RJ_DOMAIN.' && Config.PrivateZone==\`false\`].Id" --output text)"
[ -n "$ZONES" ] && [ "$ZONES" != None ] || die "no public hosted zone for $RJ_DOMAIN; this script never creates one"
[ "$(wc -w <<<"$ZONES")" -eq 1 ] || die "more than one public hosted zone for $RJ_DOMAIN ($ZONES); delete the stray one first"
HOSTED_ZONE_ID="${ZONES##*/}"
say "hosted zone: $HOSTED_ZONE_ID ($RJ_DOMAIN)"

# The registrar (Hostinger) must delegate to this zone, or nothing here resolves.
ZONE_NS="$(aws_rj route53 get-hosted-zone --id "$HOSTED_ZONE_ID" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sort)"
if command -v dig >/dev/null; then
  LIVE_NS="$(dig +short NS "$RJ_DOMAIN" | sed 's/\.$//' | sort)"
  if [ "$LIVE_NS" = "$ZONE_NS" ]; then
    say "delegation: $RJ_DOMAIN resolves through this zone's name servers"
  else
    say "WARNING: $RJ_DOMAIN's NS records ($(tr '\n' ' ' <<<"$LIVE_NS")) are not this zone's ($(tr '\n' ' ' <<<"$ZONE_NS")); certificate validation will hang"
  fi
fi

INSTANCE_ID="${RJ_INSTANCE_ID:-}"
BOX_IP=""
if [ "$DO_BOX" = 1 ]; then
  if [ -z "$INSTANCE_ID" ]; then
    [ -n "${RJ_DEPLOY_HOST:-}" ] || die "set RJ_DEPLOY_HOST (or RJ_INSTANCE_ID) in $DEPLOY_ENV"
    host="${RJ_DEPLOY_HOST#*@}"
    if [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then lookup_ip="$host"
    else lookup_ip="$(dig +short A "$host" | grep -E '^[0-9.]+$' | head -n 1 || true)"
    fi
    [ -n "$lookup_ip" ] || die "cannot resolve $host to an IP; set RJ_INSTANCE_ID in $DEPLOY_ENV"
    INSTANCE_ID="$(aws_rj ec2 describe-instances --region "$RJ_BOX_REGION" \
      --filters "Name=ip-address,Values=$lookup_ip" "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].InstanceId' --output text)"
    [ -n "$INSTANCE_ID" ] && [ "$(wc -w <<<"$INSTANCE_ID")" -eq 1 ] \
      || die "no single running instance in $RJ_BOX_REGION has public IP $lookup_ip; set RJ_INSTANCE_ID"
  fi
  read -r BOX_IP VPC_ID < <(aws_rj ec2 describe-instances --region "$RJ_BOX_REGION" --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].[PublicIpAddress,VpcId]' --output text)
  [[ "$BOX_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "instance $INSTANCE_ID has no public IPv4 address"
  CURRENT_SGS="$(aws_rj ec2 describe-instances --region "$RJ_BOX_REGION" --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)"
  say "box: $INSTANCE_ID, $BOX_IP, $VPC_ID, security groups: $CURRENT_SGS"
  EIP="$(aws_rj ec2 describe-addresses --region "$RJ_BOX_REGION" --filters "Name=instance-id,Values=$INSTANCE_ID" \
    --query 'Addresses[0].PublicIp' --output text)"
  if [ "$EIP" = None ] || [ -z "$EIP" ]; then
    say "WARNING: $BOX_IP is not an Elastic IP. A stop/start of the instance changes it; then re-run this script"
    say "         (the records follow the parameter). Associating an Elastic IP also changes it, and today's builds"
    say "         hardcode $BOX_IP: leave that until cutover (infra/README.md, \"The box's address\")."
  fi

  read -r -a SSH_CIDRS <<<"${RJ_SSH_CIDRS:-}"
  [ "${#SSH_CIDRS[@]}" -ge 1 ] || die "set RJ_SSH_CIDRS in $DEPLOY_ENV: 1 to 3 CIDRs allowed to SSH, e.g. \"203.0.113.7/32\""
  [ "${#SSH_CIDRS[@]}" -le 3 ] || die "RJ_SSH_CIDRS lists ${#SSH_CIDRS[@]} CIDRs; rj-box takes at most 3"
  for c in "${SSH_CIDRS[@]}"; do
    [[ "$c" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || die "RJ_SSH_CIDRS: \"$c\" is not an IPv4 CIDR"
    [ "$c" != 0.0.0.0/0 ] || say "WARNING: RJ_SSH_CIDRS allows SSH from anywhere (as the old group does today)"
  done
fi

EDGE_PARAMS=("DomainName=$RJ_DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID")
BOX_PARAMS=("DomainName=$RJ_DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID")
if [ "$DO_BOX" = 1 ]; then
  BOX_PARAMS+=("VpcId=$VPC_ID" "BoxPublicIp=$BOX_IP" "SshCidr1=${SSH_CIDRS[0]}" "SshCidr2=${SSH_CIDRS[1]:-}" "SshCidr3=${SSH_CIDRS[2]:-}")
fi

stack_status() {
  aws_rj cloudformation describe-stacks --region "$1" --stack-name "$2" --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || echo NONE
}

# deploy <region> <stack> <template> <params...>
deploy() {
  local region="$1" stack="$2" template="$3"
  shift 3
  local status
  status="$(stack_status "$region" "$stack")"
  say "$stack ($region): currently $status"
  case "$status" in
    *_IN_PROGRESS) [ "$status" = REVIEW_IN_PROGRESS ] || die "$stack is $status; wait for it to finish" ;;
    ROLLBACK_COMPLETE|ROLLBACK_FAILED)
      die "$stack is $status (its first create failed): read its events, then aws cloudformation delete-stack --region $region --stack-name $stack, and re-run" ;;
  esac
  case "$MODE" in
    plan)
      say "PLAN: would deploy $stack from $(basename "$template") with:"
      printf '         %s\n' "$@"
      ;;
    changeset)
      aws_rj cloudformation deploy --region "$region" --stack-name "$stack" --template-file "$template" \
        --parameter-overrides "$@" --no-execute-changeset --no-fail-on-empty-changeset \
        --tags project=rift-jumpers
      local cs
      cs="$(aws_rj cloudformation list-change-sets --region "$region" --stack-name "$stack" \
        --query 'reverse(sort_by(Summaries,&CreationTime))[0].ChangeSetName' --output text 2>/dev/null || true)"
      if [ -n "$cs" ] && [ "$cs" != None ]; then
        aws_rj cloudformation describe-change-set --region "$region" --stack-name "$stack" --change-set-name "$cs" \
          --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
      fi
      ;;
    apply)
      aws_rj cloudformation deploy --region "$region" --stack-name "$stack" --template-file "$template" \
        --parameter-overrides "$@" --no-fail-on-empty-changeset --tags project=rift-jumpers
      aws_rj cloudformation describe-stacks --region "$region" --stack-name "$stack" \
        --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
      ;;
  esac
}

if [ "$DO_EDGE" = 1 ]; then
  [ "$MODE" != apply ] || say "rj-edge: the certificate's DNS validation and the CloudFront distribution take 5-20 minutes"
  deploy "$RJ_EDGE_REGION" "$RJ_EDGE_STACK" "$EDGE_TEMPLATE" "${EDGE_PARAMS[@]}"
fi

if [ "$DO_BOX" = 1 ]; then
  deploy "$RJ_BOX_REGION" "$RJ_BOX_STACK" "$BOX_TEMPLATE" "${BOX_PARAMS[@]}"

  # Attach rj-public beside every group the box already has. modify-instance-attribute --groups REPLACES the list,
  # so the old groups are passed again; nothing is ever detached here.
  SG_ID=""
  if [ "$(stack_status "$RJ_BOX_REGION" "$RJ_BOX_STACK")" != NONE ]; then
    SG_ID="$(aws_rj cloudformation describe-stacks --region "$RJ_BOX_REGION" --stack-name "$RJ_BOX_STACK" \
      --query "Stacks[0].Outputs[?OutputKey=='SecurityGroupId'].OutputValue" --output text 2>/dev/null || true)"
  fi
  if [ -z "$SG_ID" ] || [ "$SG_ID" = None ]; then
    say "PLAN: once rj-box exists, add its rj-public group to $INSTANCE_ID beside $CURRENT_SGS"
  elif grep -qw -- "$SG_ID" <<<"$CURRENT_SGS"; then
    say "rj-public ($SG_ID) is already attached to $INSTANCE_ID"
  elif [ "$MODE" = apply ]; then
    # shellcheck disable=SC2086 # CURRENT_SGS is a list of ids
    aws_rj ec2 modify-instance-attribute --region "$RJ_BOX_REGION" --instance-id "$INSTANCE_ID" \
      --groups $CURRENT_SGS "$SG_ID"
    say "attached rj-public ($SG_ID) to $INSTANCE_ID; its groups are now: $(aws_rj ec2 describe-instances \
      --region "$RJ_BOX_REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)"
  else
    say "PLAN: would run aws ec2 modify-instance-attribute --instance-id $INSTANCE_ID --groups $CURRENT_SGS $SG_ID"
  fi
fi

[ "$MODE" != plan ] || say "PLAN only: nothing changed. --changeset to preview the change sets, --apply to deploy."
