#!/usr/bin/env bash
# Sends the box's memory and running matches to CloudWatch (RJ 487), every 5 minutes from rj-metrics.timer. EC2's own
# metrics see neither; the rj-box stack's alarms read these.
#
#   namespace RiftJumpers/Box:
#     MemAvailableMB                /proc/meminfo's MemAvailable
#     SwapUsedMB                    SwapTotal - SwapFree
#     ActiveMatches                 every running game server on the box (no dimension: what rj-box-matches-high reads)
#     ActiveMatches, Env=<env>      the same, per environment
#
# A game server is a process whose command line starts with /opt/rj/<env>/servers/: the brain execs it through
# /bin/sh (src/match/host.js), so it keeps that command line. Anchored, so a shell that merely mentions the path does
# not count.
#
# Credentials: the instance profile rj-box-metrics (PutMetricData on this namespace only); no keys on the box. The
# region comes from AWS_REGION, else the instance metadata.
#
# Test seams: RJ_ROOT, RJ_METRIC_ENVS, RJ_MEMINFO, RJ_AWS (infra/test/report_metrics.sh).
set -euo pipefail

NAMESPACE=RiftJumpers/Box
RJ_ROOT="${RJ_ROOT:-/opt/rj}"
read -r -a ENVS <<<"${RJ_METRIC_ENVS:-dev alpha}"
MEMINFO="${RJ_MEMINFO:-/proc/meminfo}"
AWS="${RJ_AWS:-aws}"

die() { echo "rj-report-metrics: $*" >&2; exit 1; }

region="${AWS_REGION:-}"
if [ -z "$region" ]; then
  token="$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  [ -n "$token" ] && region="$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)"
fi
[ -n "$region" ] || die "no region: set AWS_REGION, or run on EC2"

mem_kb() {
  local v
  v="$(awk -v k="$1:" '$1 == k { print $2 }' "$MEMINFO")"
  [[ "$v" =~ ^[0-9]+$ ]] || die "no $1 in $MEMINFO"
  echo "$v"
}
avail_mb=$(($(mem_kb MemAvailable) / 1024))
swap_used_mb=$((($(mem_kb SwapTotal) - $(mem_kb SwapFree)) / 1024))

metric() { # metric <name> <value> <unit> [<env>]
  local dims=""
  [ -z "${4:-}" ] || dims=",\"Dimensions\":[{\"Name\":\"Env\",\"Value\":\"$4\"}]"
  printf '{"MetricName":"%s","Value":%s,"Unit":"%s"%s}' "$1" "$2" "$3" "$dims"
}

data="$(metric MemAvailableMB "$avail_mb" Megabytes),$(metric SwapUsedMB "$swap_used_mb" Megabytes)"
total=0
summary=""
for env in "${ENVS[@]}"; do
  n="$(pgrep -c -f "^$RJ_ROOT/$env/servers/" || true)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  total=$((total + n))
  data="$data,$(metric ActiveMatches "$n" Count "$env")"
  summary="$summary $env=$n"
done
data="$data,$(metric ActiveMatches "$total" Count)"

"$AWS" --no-cli-pager cloudwatch put-metric-data --region "$region" --namespace "$NAMESPACE" --metric-data "[$data]"
echo "sent: MemAvailableMB=$avail_mb SwapUsedMB=$swap_used_mb ActiveMatches=$total ($summary )"
