#!/usr/bin/env bash
# Measures the box's real capacity per match (RJ 484): memory, CPU and CPU credits, idle and with 1, 2 and 3 bots'
# matches running at once, plus the brains. Dev's game server only (--open_mode refuses alpha). Wobble Planet's
# docs/backend-ops.md, "Capacity", holds the results and how to read them.
#
#   bash ops/drills/measure_capacity.sh                       PLAN: read-only checks over SSH; prints what --run would do
#   bash ops/drills/measure_capacity.sh --run                 the staged run, ~14 min at the defaults
#   bash ops/drills/measure_capacity.sh --run --session 45    ... then 45 min of back-to-back matches (the credit run)
#   bash ops/drills/measure_capacity.sh --report DIR          re-renders a run's report, fetching CloudWatch again
#                                                             (its 5-minute figures arrive ~10 min late)
#
#   --matches N           the most matches at once, 1-3 (default 3): the stages are 1, 2, ... N
#   --stage-sec SEC       how long each stage is measured once its matches are in game (default 180)
#   --idle-sec SEC        the idle baseline before, and the cool-down after (default 60)
#   --session MIN         after the stages, MIN minutes of --session-matches matches back to back (default 0: none)
#   --session-matches K   matches at once in the session (default 2)
#   --interval SEC        seconds between samples (default 5)
#   --floor-mb MB         MemAvailable under this stops every server and ends the run (default 150; never lower)
#   --ports "P ..."       UDP ports to use (default "8101 8102 8103 8104"; dev's range 8100-8104 only)
#   --binary PATH         the server on the box (default: dev's newest active manifest entry)
#   --out DIR             where the run is kept (default $RJ_DRILL_STATE_DIR/capacity-<time>, ~/.config/rift-jumpers)
#   --no-cloudwatch       skip CloudWatch (it is also skipped, with a note, when the profile cannot read it)
# Local test seam (ops/drills/test/measure_capacity_local.sh): --transport "CMD ..." runs every box command as
# `CMD "<command>"` instead of over SSH; --brains "name=pattern;..." replaces the processes sampled besides the servers.
#
# Safety, because the legacy brain and real players share the box:
#   - PLAN is the default and starts nothing: it reads /proc, the manifest and pm2's processes, and CloudWatch
#   - at most 3 matches; only ports 8100-8104, never the legacy 8080-8085; a port already in use is skipped
#   - before each server starts, MemAvailable less a server's measured size (x1.2) must stay above the floor, or that
#     stage runs short; MemAvailable under the floor at any sample kills every server at once and ends the run
#   - the agent (ops/drills/capacity_agent.sh) runs detached on the box with its own EXIT trap, so a dropped SSH or a
#     sleeping Mac still ends on plan; every server also runs under `timeout -s KILL` to the plan's end
#   - this script's own EXIT trap (Ctrl-C included) asks the agent to stop, then kills any server it recorded
set -euo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DRILL_DIR/../.." && pwd)"
# shellcheck source=../../infra/stacks.env
. "$REPO_DIR/infra/stacks.env"

INSTANCE_ID="${RJ_INSTANCE_ID:-i-065349bc673575b5f}"
INSTANCE_TYPE="t2.micro"
RUN=0
REPORT_DIR=""
MATCHES=3
STAGE_SEC=180
IDLE_SEC=60
SESSION_MIN=0
SESSION_MATCHES=2
INTERVAL=5
FLOOR_MB=150
PORTS="8101 8102 8103 8104"
BINARY=""
OUT=""
CLOUDWATCH=1
TRANSPORT_CMD=""
BRAINS="legacy=/home/ec2-user/Rift-Brain/src/app.js;dev=/opt/rj/dev/brain/src/app.js;alpha=/opt/rj/alpha/brain/src/app.js;pm2=PM2 v;mariadb=/usr/libexec/mariadbd;caddy=/usr/local/bin/caddy"
EST_MB=250
WARMUP_SEC=40

say() { echo "[capacity] $*"; }
die() { echo "$(basename "$0"): $*" >&2; exit 2; }
int_arg() { [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge "${3:-1}" ] || die "$1 needs a whole number of at least ${3:-1}, not '$2'"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN=1; shift ;;
    --report) REPORT_DIR="${2:?--report needs a run directory}"; shift 2 ;;
    --matches) int_arg "$1" "${2:-}"; MATCHES="$2"; shift 2 ;;
    --stage-sec) int_arg "$1" "${2:-}" 10; STAGE_SEC="$2"; shift 2 ;;
    --idle-sec) int_arg "$1" "${2:-}" 0; IDLE_SEC="$2"; shift 2 ;;
    --session) int_arg "$1" "${2:-}" 0; SESSION_MIN="$2"; shift 2 ;;
    --session-matches) int_arg "$1" "${2:-}"; SESSION_MATCHES="$2"; shift 2 ;;
    --interval) int_arg "$1" "${2:-}" 2; INTERVAL="$2"; shift 2 ;;
    --floor-mb) int_arg "$1" "${2:-}" 150; FLOOR_MB="$2"; shift 2 ;;
    --ports) PORTS="${2:?--ports needs a list}"; shift 2 ;;
    --binary) BINARY="${2:?--binary needs a path}"; shift 2 ;;
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --no-cloudwatch) CLOUDWATCH=0; shift ;;
    --transport) TRANSPORT_CMD="${2:?--transport needs a command}"; shift 2 ;;
    --brains) BRAINS="${2?--brains needs a list}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ "$MATCHES" -le 3 ] || die "--matches is at most 3: the legacy brain shares this box"
[ "$SESSION_MATCHES" -le 3 ] || die "--session-matches is at most 3: the legacy brain shares this box"
NPORTS=0
for p in $PORTS; do
  [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 8100 ] && [ "$p" -le 8104 ] \
    || die "port $p is outside dev's game-server range 8100-8104 (never alpha's 8090-8099 or the legacy 8080-8085)"
  NPORTS=$((NPORTS + 1))
done
NEED=$MATCHES; [ "$SESSION_MATCHES" -gt "$NEED" ] && [ "$SESSION_MIN" -gt 0 ] && NEED=$SESSION_MATCHES
[ "$NPORTS" -ge "$NEED" ] || die "--ports names $NPORTS port(s), fewer than the $NEED matches asked for"

# --- the transport: SSH with one shared connection, or the test's command --------------------------------------------
CM_DIR=""
if [ -n "$TRANSPORT_CMD" ]; then
  read -r -a TRANSPORT <<<"$TRANSPORT_CMD"
  TARGET="$TRANSPORT_CMD"
else
  DEPLOY_ENV="${RJ_DEPLOY_ENV_FILE:-$HOME/.config/rift-jumpers/deploy.env}"
  [ -r "$DEPLOY_ENV" ] || die "no $DEPLOY_ENV (RJ_DEPLOY_PEM, RJ_DEPLOY_HOST)"
  # shellcheck disable=SC1090
  . "$DEPLOY_ENV"
  : "${RJ_DEPLOY_PEM:?deploy.env has no RJ_DEPLOY_PEM}" "${RJ_DEPLOY_HOST:?deploy.env has no RJ_DEPLOY_HOST}"
  CM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rj-cap.XXXXXX")"
  TRANSPORT=(ssh -i "$RJ_DEPLOY_PEM" -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
    -o ControlMaster=auto -o ControlPath="$CM_DIR/cm" -o ControlPersist=120 -o LogLevel=ERROR "$RJ_DEPLOY_HOST")
  TARGET="$RJ_DEPLOY_HOST"
fi
box() { "${TRANSPORT[@]}" "$1"; }

# --- CloudWatch ------------------------------------------------------------------------------------------------------
cw_ok() {
  [ "$CLOUDWATCH" = 1 ] || return 1
  command -v aws >/dev/null 2>&1 || { CW_WHY="the aws CLI is not installed"; return 1; }
  local err
  if ! err="$(aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUCreditBalance \
      --dimensions "Name=InstanceId,Value=$INSTANCE_ID" --start-time "$(iso_ago 1800)" --end-time "$(iso_ago 0)" \
      --period 300 --statistics Average --region "$RJ_BOX_REGION" --profile "$RJ_AWS_PROFILE" --output json 2>&1)"; then
    if grep -q "AccessDenied\|not authorized" <<<"$err"; then
      CW_WHY="profile $RJ_AWS_PROFILE may not read CloudWatch: attach the AWS managed policy CloudWatchReadOnlyAccess to its IAM user (or allow cloudwatch:GetMetricStatistics)"
    else
      CW_WHY="CloudWatch did not answer: $(head -c 200 <<<"$err")"
    fi
    return 1
  fi
  CW_LAST="$(python3 -c 'import json,sys; d=sorted(json.load(sys.stdin)["Datapoints"], key=lambda p: p["Timestamp"]); print(d[-1]["Average"] if d else "none")' <<<"$err")"
  return 0
}
iso_ago() { python3 -c 'import datetime,sys; t=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=int(sys.argv[1])); print(t.strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }
iso_at() { python3 -c 'import datetime,sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }

# cw_fetch <dir> <start epoch> <end epoch>: the instance's credit and CPU figures, 5-minute periods, as JSON files.
cw_fetch() {
  local dir="$1" t0="$2" t1="$3" m stat
  CW_WHY=""
  if ! cw_ok; then
    say "CloudWatch skipped: ${CW_WHY:-turned off with --no-cloudwatch}"
    echo "${CW_WHY:-turned off with --no-cloudwatch}" >"$dir/cloudwatch.skipped"
    return 0
  fi
  rm -f "$dir/cloudwatch.skipped"
  for m in CPUCreditBalance CPUCreditUsage CPUUtilization; do
    stat=Average; [ "$m" = CPUCreditUsage ] && stat=Sum
    aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name "$m" \
      --dimensions "Name=InstanceId,Value=$INSTANCE_ID" --start-time "$(iso_at "$((t0 - 900))")" \
      --end-time "$(iso_at "$((t1 + 900))")" --period 300 --statistics "$stat" Maximum Minimum \
      --region "$RJ_BOX_REGION" --profile "$RJ_AWS_PROFILE" --output json >"$dir/cw_$m.json"
  done
  say "CloudWatch figures saved ($(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["Datapoints"]))' "$dir/cw_CPUCreditBalance.json") five-minute points of the balance)"
}

render() {
  local dir="$1"
  python3 "$DRILL_DIR/capacity_report.py" "$dir" | tee "$dir/report.md"
  say "the report is $dir/report.md; the samples $dir/samples.csv"
}

if [ -n "$REPORT_DIR" ]; then
  [ -s "$REPORT_DIR/samples.csv" ] && [ -s "$REPORT_DIR/meta.env" ] || die "$REPORT_DIR holds no run (samples.csv, meta.env)"
  # shellcheck disable=SC1091
  . "$REPORT_DIR/meta.env"
  cw_fetch "$REPORT_DIR" "$RUN_START" "$RUN_END"
  render "$REPORT_DIR"
  exit 0
fi

# --- the plan -------------------------------------------------------------------------------------------------------
PHASES="idle:0:$IDLE_SEC"
for ((m = 1; m <= MATCHES; m++)); do PHASES="$PHASES m$m:$m:$STAGE_SEC"; done
[ "$SESSION_MIN" -gt 0 ] && PHASES="$PHASES session:$SESSION_MATCHES:$((SESSION_MIN * 60))"
PHASES="$PHASES cool:0:$IDLE_SEC"
PLAN_SEC=0; NSTARTS=0
for ph in $PHASES; do IFS=: read -r _ n s <<<"$ph"; PLAN_SEC=$((PLAN_SEC + s)); done
NSTARTS=$MATCHES; [ "$SESSION_MATCHES" -gt "$MATCHES" ] && [ "$SESSION_MIN" -gt 0 ] && NSTARTS=$SESSION_MATCHES

# The read-only preflight: one round trip, KEY=value lines.
PREFLIGHT=$(cat <<'EOS'
set -u
echo "NPROC=$(nproc 2>/dev/null || echo ?)"
awk '/^MemTotal:/{print "MEM_TOTAL_KB="$2} /^MemAvailable:/{print "MEM_AVAIL_KB="$2} /^SwapTotal:/{t=$2} /^SwapFree:/{print "SWAP_USED_KB="t-$2}' /proc/meminfo
echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg)"
BIN="__BINARY__"
if [ -z "$BIN" ]; then
  M=/opt/rj/dev/servers/manifest.json
  if [ -r "$M" ]; then
    P="$(python3 -c 'import json,sys; s=[x for x in json.load(open(sys.argv[1]))["servers"] if x.get("status")=="active"]; print(s[-1]["path"] if s else "")' "$M" 2>/dev/null)"
    [ -n "$P" ] && BIN="/opt/rj/dev/servers/$P"
  fi
fi
echo "BIN=$BIN"
if [ -n "$BIN" ] && [ -x "$BIN" ]; then echo "BIN_OK=1"; echo "BIN_SIZE_MB=$(( $(stat -c %s "$BIN") / 1048576 ))"; else echo "BIN_OK=0"; fi
for t in timeout nohup awk grep; do command -v "$t" >/dev/null 2>&1 || echo "MISSING_TOOL=$t"; done
for p in __PORTS__; do
  hex="$(printf '%04X' "$p")"
  awk -v p=":$hex" 'NR > 1 && substr($2, length($2) - 4) == p { f = 1 } END { exit !f }' /proc/net/udp /proc/net/udp6 2>/dev/null && echo "PORT_BUSY=$p"
done
IFS=';' read -r -a entries <<<"__BRAINS__"
for e in "${entries[@]}"; do
  [ -n "$e" ] || continue
  n="${e%%=*}"; pat="${e#*=}"
  for f in $(grep -laF -- "$pat" /proc/[0-9]*/cmdline 2>/dev/null); do
    p="${f#/proc/}"; p="${p%/cmdline}"
    [ "$(cat "/proc/$p/comm" 2>/dev/null)" = grep ] && continue
    echo "PROC=$n $p $(awk '/^VmRSS:/{print int($2/1024)}' "/proc/$p/status" 2>/dev/null)"
  done
done
B="$(basename "${BIN:-server.x86_64}")"
for f in $(grep -laF -- "$B" /proc/[0-9]*/cmdline 2>/dev/null); do
  p="${f#/proc/}"; p="${p%/cmdline}"
  c="$(cat "/proc/$p/comm" 2>/dev/null)"; [ "$c" = grep ] || [ "$c" = timeout ] && continue
  echo "OTHER_SERVER=$p $(tr '\0' ' ' <"/proc/$p/cmdline" | cut -c1-160)"
done
ls -d /tmp/rj-capacity-* 2>/dev/null | sed 's/^/LEFTOVER=/'
EOS
)
PREFLIGHT="${PREFLIGHT//__BINARY__/$BINARY}"
PREFLIGHT="${PREFLIGHT//__PORTS__/$PORTS}"
PREFLIGHT="${PREFLIGHT//__BRAINS__/$BRAINS}"

say "box: $TARGET"
PF="$(box "bash -s" <<<"$PREFLIGHT")" || die "could not reach the box over $TARGET"
pf() { sed -n "s/^$1=//p" <<<"$PF"; }
MEM_AVAIL_KB="$(pf MEM_AVAIL_KB | head -1)"; MEM_AVAIL_KB="${MEM_AVAIL_KB:-0}"
BIN="$(pf BIN | head -1)"
MEM_TOTAL_KB="$(pf MEM_TOTAL_KB)"; SWAP_USED_KB="$(pf SWAP_USED_KB)"
say "  cores $(pf NPROC), memory $(( ${MEM_TOTAL_KB:-0} / 1024 )) MB, available $((MEM_AVAIL_KB / 1024)) MB, swap used $(( ${SWAP_USED_KB:-0} / 1024 )) MB, load $(pf LOAD)"
PROBLEMS=0
if [ "$(pf BIN_OK)" = 1 ]; then say "  server: $BIN ($(pf BIN_SIZE_MB) MB)"; else say "  PROBLEM: no executable server at '${BIN:-<none active in the dev manifest>}'"; PROBLEMS=1; fi
while read -r t; do [ -n "$t" ] && { say "  PROBLEM: the box has no '$t'"; PROBLEMS=1; }; done <<<"$(pf MISSING_TOOL)"
FREE_PORTS=0
for p in $PORTS; do
  if grep -qx "$p" <<<"$(pf PORT_BUSY)"; then say "  port $p is in use (a dev lobby?): it will be skipped"; else FREE_PORTS=$((FREE_PORTS + 1)); fi
done
[ "$FREE_PORTS" -ge "$NSTARTS" ] || { say "  PROBLEM: $FREE_PORTS free port(s) among [$PORTS], $NSTARTS needed"; PROBLEMS=1; }
while read -r line; do [ -n "$line" ] && say "  sampled: ${line}${line:+ MB}"; done <<<"$(pf PROC)"
while read -r line; do [ -n "$line" ] && say "  another game server is running (counted as other-server): $line"; done <<<"$(pf OTHER_SERVER)"
while read -r line; do [ -n "$line" ] && say "  NOTE: a run directory is left over from an earlier run: $line (an interrupted run; nothing in it runs)"; done <<<"$(pf LEFTOVER)"
HEADROOM_MB=$(( MEM_AVAIL_KB / 1024 - FLOOR_MB ))
say "  headroom over the ${FLOOR_MB} MB floor: ${HEADROOM_MB} MB (each server is assumed ${EST_MB} MB until one is measured)"
[ "$HEADROOM_MB" -gt "$EST_MB" ] || { say "  PROBLEM: not even one server fits over the floor now"; PROBLEMS=1; }

CW_WHY=""
if cw_ok; then
  say "  CloudWatch: readable; CPUCreditBalance now $CW_LAST (a t2.micro earns 6 an hour and holds at most 144)"
  MODE="$(aws ec2 describe-instance-credit-specifications --instance-ids "$INSTANCE_ID" --region "$RJ_BOX_REGION" \
    --profile "$RJ_AWS_PROFILE" --query 'InstanceCreditSpecifications[0].CpuCredits' --output text 2>/dev/null || echo unknown)"
  say "  credit mode: $MODE"
else
  say "  CloudWatch: ${CW_WHY:-off (--no-cloudwatch)}; the report estimates credits from the sampled CPU instead"
  MODE=unknown
fi

say "plan:"
for ph in $PHASES; do
  IFS=: read -r name n s <<<"$ph"
  say "  $name: $n match(es), ${s}s measured (each new match first gets up to ${WARMUP_SEC}s to reach INGAME)"
done
say "  sample every ${INTERVAL}s; abort under ${FLOOR_MB} MB available; ports [$PORTS]; at most $NSTARTS server(s) at once"
say "  about $(( (PLAN_SEC + NSTARTS * WARMUP_SEC + 59) / 60 + 1 )) min in all"

if [ "$RUN" = 0 ]; then
  say "PLAN only: nothing was started. --run does it."
  if [ "$PROBLEMS" = 0 ]; then say "PLAN OK"; exit 0; fi
  say "PLAN FAIL: fix the PROBLEM lines first"
  exit 1
fi
[ "$PROBLEMS" = 0 ] || die "refusing to run: fix the PROBLEM lines first"

# --- the run --------------------------------------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-${RJ_DRILL_STATE_DIR:-$HOME/.config/rift-jumpers}/capacity-$STAMP}"
mkdir -p "$OUT"
RDIR="/tmp/rj-capacity-$STAMP"
AGENT_PID=""
RUN_START="$(date +%s)"
FETCHED=0

fetch() {
  [ "$FETCHED" = 1 ] && return 0
  box "cat $RDIR/samples.csv" >"$OUT/samples.csv" 2>/dev/null || true
  box "cat $RDIR/events.log" >"$OUT/events.log" 2>/dev/null || true
  box "cd $RDIR 2>/dev/null && for f in server-*.log; do [ -e \"\$f\" ] || continue; echo \"=== \$f (last 30 lines)\"; tail -n 30 \"\$f\"; done" \
    >"$OUT/server_logs.txt" 2>/dev/null || true
  FETCHED=1
}

# shellcheck disable=SC2329 # the EXIT trap's
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "$AGENT_PID" ]; then
    if box "kill -0 $AGENT_PID 2>/dev/null"; then
      say "stopping the agent on the box (pid $AGENT_PID) ..."
      box "touch $RDIR/stop; for i in \$(seq 1 40); do kill -0 $AGENT_PID 2>/dev/null || break; sleep 0.5; done; kill -TERM $AGENT_PID 2>/dev/null; sleep 3; kill -KILL $AGENT_PID 2>/dev/null; true" || true
    fi
    # Whatever the agent recorded and is still alive, whoever's fault: killed.
    box "[ -r $RDIR/pids ] && while read -r a b; do for p in \$a \$b; do kill -0 \$p 2>/dev/null && kill -KILL \$p && echo \"killed leftover \$p\"; done; done <$RDIR/pids; true" || true
    LEFT="$(box "[ -r $RDIR/pids ] && for p in \$(cat $RDIR/pids); do grep -qaF -- '$(basename "$BIN")' /proc/\$p/cmdline 2>/dev/null && echo \$p; done; true" || true)"
    [ -z "$LEFT" ] || say "WARNING: server pid(s) of this run still alive on the box: $LEFT"
    fetch
    box "rm -rf $RDIR" || true
  fi
  [ -z "$CM_DIR" ] || { ssh -o ControlPath="$CM_DIR/cm" -O exit "$RJ_DEPLOY_HOST" >/dev/null 2>&1 || true; rm -rf "$CM_DIR"; }
  exit "$rc"
}
trap cleanup EXIT
trap 'say "interrupted"; exit 130' INT TERM

{
  echo "RUN_START=$RUN_START"
  echo "INSTANCE_ID=$INSTANCE_ID"
  echo "INSTANCE_TYPE=$INSTANCE_TYPE"
  echo "CREDIT_MODE=$MODE"
  echo "BINARY=$BIN"
  echo "WIRE_DIR=$(basename "$(dirname "$BIN")")"
  echo "PHASES='$PHASES'"
  echo "INTERVAL=$INTERVAL"
  echo "FLOOR_MB=$FLOOR_MB"
  echo "NPROC=$(pf NPROC)"
  echo "MEM_TOTAL_KB=$(pf MEM_TOTAL_KB)"
} >"$OUT/meta.env"

box "mkdir -p $RDIR && cat >$RDIR/agent.sh" <"$DRILL_DIR/capacity_agent.sh"
ENVS="RUN_DIR=$RDIR BIN=$(printf '%q' "$BIN") PORTS='$PORTS' PHASES='$PHASES' INTERVAL=$INTERVAL FLOOR_KB=$((FLOOR_MB * 1024)) EST_KB=$((EST_MB * 1024)) WARMUP_SEC=$WARMUP_SEC BRAINS=$(printf '%q' "$BRAINS")"
# One simple command after the `&`, so the background child execs nohup itself; the agent writes its own pid.
box "cd $RDIR || exit 1; $ENVS \$(command -v setsid) nohup bash agent.sh </dev/null >agent.out 2>&1 &" >/dev/null
AGENT_PID="$(box "for i in \$(seq 1 50); do [ -s $RDIR/agent.pid ] && break; sleep 0.1; done; cat $RDIR/agent.pid 2>/dev/null")"
[[ "$AGENT_PID" =~ ^[0-9]+$ ]] || { AGENT_PID=0; die "the agent did not start: $(box "cat $RDIR/agent.out 2>/dev/null" | tail -5)"; }
say "the agent runs on the box as pid $AGENT_PID in $RDIR; samples are kept in $OUT"

SEEN=0
while :; do
  sleep 10
  NEW="$(box "tail -n +$((SEEN + 1)) $RDIR/events.log 2>/dev/null; kill -0 $AGENT_PID 2>/dev/null && echo __ALIVE__; true")" || { say "(the box did not answer; retrying)"; continue; }
  while IFS= read -r line; do
    [ "$line" = __ALIVE__ ] && continue
    [ -n "$line" ] || continue
    SEEN=$((SEEN + 1))
    read -r _ el rest <<<"$line"
    printf '[capacity] +%4ss %s\n' "$el" "$rest"
  done <<<"$NEW"
  grep -qx __ALIVE__ <<<"$NEW" || break
done
RUN_END="$(date +%s)"
echo "RUN_END=$RUN_END" >>"$OUT/meta.env"
fetch
grep -q " ABORT " "$OUT/events.log" && say "the run ABORTED early: see the events above"
cw_fetch "$OUT" "$RUN_START" "$RUN_END"
render "$OUT"
say "CloudWatch's five-minute figures arrive ~10 min late: in 15 min, re-render with"
say "  bash ops/drills/measure_capacity.sh --report $OUT"
