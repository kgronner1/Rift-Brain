#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2001 # checks pass values to `bash -c '...' _ "$x"` on purpose; sed indents output
# Tests ops/drills/measure_capacity.sh and its box agent against a stand-in box -- never the real one (RJ 484).
#
#   bash ops/drills/test/measure_capacity_local.sh <path/to/server.x86_64>     ~10 min; needs Docker
#   KEEP=1 bash ops/drills/test/measure_capacity_local.sh <bin>                leave the container up at the end
#
# The server is an exported dedicated server (Wobble Planet's `bash deploy_server.sh --env dev --no-upload` leaves one;
# docs/backend-realtime.md, "The boot check"). The stand-in box is Docker amazonlinux:2023 (linux/amd64, the box's OS)
# holding the binary under /opt/rj/dev/servers with a manifest, and processes whose command lines are the box's:
#   - a sleeping "legacy brain" and "alpha brain", and a "dev brain" that spins one core flat out: the sampler must
#     show the one at ~100 % and the others at ~0, which proves the CPU measurement before any figure is trusted
#   - a real game server on UDP 8101 that the run did not start: counted as other-server, and its port skipped
# measure_capacity.sh reaches it with --transport "docker exec ...", in place of SSH.
#
# Graded, each a TEST PASS / TEST FAIL line:
#   - the refusals: 4 matches, a legacy port, a floor under 150 MB, each exit 2 with nothing started
#   - PLAN: passes, reports the busy port, the other server and the three brains, and starts nothing
#   - --run (2 stages and a 4-min back-to-back session): a report; both servers measured in game (RSS over 50 MB); the
#     spinning brain ~100 % and the sleeping one ~0; the other server sampled; port 8101 never used; nothing of the
#     run's left running and its box directory gone. Whether a match ended (and its server was replaced) is printed
#   - stopped with SIGTERM mid-run: exits, its servers are killed, its samples are kept, the box directory is gone
#   - the agent alone, with a floor just under the memory available: a server starts, the floor is crossed, ABORT, and
#     no server is left
set -uo pipefail

BIN="${1:-}"
[ -n "$BIN" ] && [ -f "$BIN" ] || { echo "usage: bash $0 <path/to/server.x86_64>"; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILLS="$(cd "$HERE/.." && pwd)"
CTR=rj-capacity-test
IMAGE=amazonlinux:2023
WIRE_DIR=/opt/rj/dev/servers/wire-9-test
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-capacity-test.XXXXXX")"

FAILED=0
tpass() { echo "TEST PASS  $*"; }
tfail() { FAILED=1; echo "TEST FAIL  $*"; }
tdie() { tfail "$*"; exit 1; }
check() { local label="$1"; shift; if "$@"; then tpass "$label"; else tfail "$label"; fi; }
info() { echo "TEST INFO  $*"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then tdie "Docker is not running"; fi

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: the container $CTR is still up (docker rm -f $CTR); the runs are in $WORK"
  else
    docker rm -f "$CTR" >/dev/null 2>&1
    rm -rf "$WORK"
  fi
  if [ "$FAILED" = 0 ]; then echo "MEASURE CAPACITY TEST: PASS"; else echo "MEASURE CAPACITY TEST: FAIL"; exit 1; fi
}
trap cleanup EXIT

# --- the stand-in box ------------------------------------------------------------------------------------------------
docker rm -f "$CTR" >/dev/null 2>&1
docker run -d --name "$CTR" --platform linux/amd64 --init "$IMAGE" sleep infinity >/dev/null || tdie "could not start $IMAGE"
as_root() { docker exec -i "$CTR" bash -c "$1"; }
as_user() { docker exec -i -u 1000 -e HOME=/tmp/home "$CTR" bash -c "$1"; }
as_root "mkdir -p $WIRE_DIR /tmp/home && chown -R 1000:1000 /opt/rj /tmp/home" || tdie "box setup"
docker cp "$BIN" "$CTR:$WIRE_DIR/server.x86_64" >/dev/null || tdie "copying the binary in"
as_root "chown 1000:1000 $WIRE_DIR/server.x86_64 && chmod 755 $WIRE_DIR/server.x86_64"
as_user "cat >/opt/rj/dev/servers/manifest.json" <<'EOF'
{"servers": [{"wire": 9, "fp": "test", "path": "wire-9-test/server.x86_64", "sha": "test", "status": "active"}]}
EOF
# A renamed bash, not a renamed sleep: the image's coreutils is one multi-call binary that dispatches on argv[0].
docker exec -d -u 1000 "$CTR" bash -c 'exec -a "node /home/ec2-user/Rift-Brain/src/app.js" bash -c "while :; do sleep 60; done"'
docker exec -d -u 1000 "$CTR" bash -c 'exec -a "/usr/bin/node-20 /opt/rj/alpha/brain/src/app.js" bash -c "while :; do sleep 60; done"'
docker exec -d -u 1000 "$CTR" bash -c 'exec -a "/usr/bin/node-20 /opt/rj/dev/brain/src/app.js" bash -c "while :; do :; done"'
docker exec -d -u 1000 -e HOME=/tmp/home "$CTR" bash -c \
  "cd $WIRE_DIR && exec ./server.x86_64 --port=8101 --net_env=dev --open_mode >/tmp/home/foreign.log 2>&1"
for _ in $(seq 1 60); do as_user "grep -q 'ready: listening' /tmp/home/foreign.log" && break; sleep 1; done
as_user "grep -q 'ready: listening' /tmp/home/foreign.log" || tdie "the other server never got ready: $(as_user 'tail -5 /tmp/home/foreign.log')"
FOREIGN_PID="$(as_user "for p in /proc/[0-9]*; do [ \"\$(cat \$p/comm 2>/dev/null)\" = server.x86_64 ] && echo \${p#/proc/}; done" | head -1)"
info "the stand-in box is up; the other server is pid $FOREIGN_PID on 8101"

TRANSPORT="docker exec -i -u 1000 -e HOME=/tmp/home $CTR bash -c"
MC=(bash "$DRILLS/measure_capacity.sh" --transport "$TRANSPORT" --no-cloudwatch)

# Our servers on the box: every server.x86_64 but the other one.
our_servers() {
  as_user "for p in /proc/[0-9]*; do [ \"\$(cat \$p/comm 2>/dev/null)\" = server.x86_64 ] && echo \${p#/proc/}; done" \
    | grep -vx "$FOREIGN_PID" || true
}
no_run_dirs() { [ -z "$(as_user 'ls -d /tmp/rj-capacity-* 2>/dev/null')" ]; }

# --- the refusals ----------------------------------------------------------------------------------------------------
refused() {
  local out rc
  out="$("${MC[@]}" "$@" 2>&1)"; rc=$?
  [ "$rc" = 2 ] && [ -z "$(our_servers)" ] || { echo "$out" | sed 's/^/    /'; return 1; }
}
check "refuses --matches 4" refused --matches 4 --run
check "refuses a legacy port" refused --ports "8085 8101" --run
check "refuses a floor under 150 MB" refused --floor-mb 100 --run

# --- PLAN ------------------------------------------------------------------------------------------------------------
PLAN="$("${MC[@]}" 2>&1)"; RC=$?
echo "$PLAN" | sed 's/^/    /'
check "PLAN passes" grep -q "PLAN OK" <<<"$PLAN"
[ "$RC" = 0 ] || tfail "PLAN exited $RC"
check "PLAN finds the manifest's server" grep -q "server: $WIRE_DIR/server.x86_64" <<<"$PLAN"
check "PLAN sees port 8101 in use" grep -q "port 8101 is in use" <<<"$PLAN"
check "PLAN sees the other server" grep -q "another game server is running" <<<"$PLAN"
check "PLAN finds the three brains" bash -c 'for b in legacy dev alpha; do grep -q "sampled: $b " <<<"$1" || exit 1; done' _ "$PLAN"
check "PLAN starts nothing" bash -c '[ -z "$1" ]' _ "$(our_servers)"
check "PLAN leaves no directory on the box" no_run_dirs

# --- a run -----------------------------------------------------------------------------------------------------------
OUT="$WORK/run"
info "a run: idle 15 s, 1 and 2 matches for 45 s each, a 4-min session of 2, cool 15 s (~8 min) ..."
"${MC[@]}" --run --matches 2 --stage-sec 45 --idle-sec 15 --session 4 --session-matches 2 --interval 3 --out "$OUT" \
  >"$WORK/run.log" 2>&1; RC=$?
grep -v '^|' "$WORK/run.log" | sed 's/^/    /' | head -60
check "the run exits 0" [ "$RC" = 0 ]
check "the run wrote a report" test -s "$OUT/report.md"
CSV="$OUT/samples.csv"
col_stat() {  # col_stat <who regex> <column> <state or ""> -> "count mean max" over settled rows
  python3 - "$CSV" "$1" "$2" "$3" <<'EOF'
import csv, re, sys
path, who, col, state = sys.argv[1:]
xs = []
for r in csv.DictReader(open(path)):
    if r["settled"] != "1" or not re.fullmatch(who, r["who"]) or (state and r.get("state") != state):
        continue
    try: xs.append(float(r[col]))
    except ValueError: pass
print(len(xs), (sum(xs) / len(xs)) if xs else 0, max(xs) if xs else 0)
EOF
}
read -r n0 _ rss0 <<<"$(col_stat 'server\.0' rss_kb ingame)"
read -r n1 _ rss1 <<<"$(col_stat 'server\.1' rss_kb ingame)"
info "server.0: $n0 in-game samples, RSS max ${rss0%.*} kB; server.1: $n1, ${rss1%.*} kB"
check "both servers measured in game, RSS over 50 MB" bash -c "[ $n0 -gt 0 ] && [ $n1 -gt 0 ] && [ ${rss0%.*} -gt 51200 ] && [ ${rss1%.*} -gt 51200 ]"
read -r nd dev_cpu _ <<<"$(col_stat dev cpu_pct "")"
read -r nl leg_cpu _ <<<"$(col_stat legacy cpu_pct "")"
info "the spinning dev brain: ${dev_cpu} % over $nd samples; the sleeping legacy brain: ${leg_cpu} % over $nl"
check "CPU measured: the spinning brain ~100 %, the sleeping one ~0" \
  python3 -c "import sys; d, l = float(sys.argv[1]), float(sys.argv[2]); sys.exit(0 if d > 70 and l < 2 else 1)" "$dev_cpu" "$leg_cpu"
read -r nbox avail _ <<<"$(col_stat box avail_kb "")"
check "box rows sampled with memory available" bash -c "[ $nbox -gt 10 ] && [ ${avail%.*} -gt 0 ]"
check "the other server is sampled as other-server" grep -q ",other-server\.$FOREIGN_PID," "$CSV"
check "port 8101 was never used" bash -c '! grep -q "START .* port 8101 " "$1" && grep -q "START .* port 8102 " "$1"' _ "$OUT/events.log"
check "the run ended DONE, not ABORT" bash -c 'grep -q " DONE " "$1" && ! grep -q " ABORT " "$1"' _ "$OUT/events.log"
check "nothing of the run is left running" bash -c '[ -z "$1" ]' _ "$(our_servers)"
check "the run's box directory is gone" no_run_dirs
check "the run's agent was the one sampled nowhere (no launcher shell as a brain)" bash -c '! grep -q ",dev\.[0-9]*," "$1"' _ "$CSV"
ENDED="$(grep -c ' POSTGAME ' "$OUT/events.log")"
info "matches that ended during the run: $ENDED (each replaced by a fresh server: $(grep -c 'its match is over' "$OUT/events.log") stop(s))"
sed -n '/^## Derived/,/^## CPU credits/p' "$OUT/report.md" | sed 's/^/    /'

# --- stopped mid-run -------------------------------------------------------------------------------------------------
OUT2="$WORK/stopped"
info "a run stopped with SIGTERM once its first match is in game ..."
"${MC[@]}" --run --matches 2 --stage-sec 120 --idle-sec 5 --interval 2 --out "$OUT2" >"$WORK/stopped.log" 2>&1 &
DPID=$!
for _ in $(seq 1 90); do [ -n "$(our_servers)" ] && break; sleep 1; done
[ -n "$(our_servers)" ] || tfail "the stopped run never started a server"
sleep 15
kill -TERM "$DPID"
wait "$DPID"; RC=$?
sed 's/^/    /' "$WORK/stopped.log" | tail -12
check "the stopped run exits non-zero" [ "$RC" != 0 ]
check "its servers are killed" bash -c '[ -z "$1" ]' _ "$(our_servers)"
check "its samples are kept" bash -c '[ "$(wc -l <"$1")" -gt 3 ]' _ "$OUT2/samples.csv"
check "its events say it stopped" grep -q "ABORT a stop was asked for\|SIGNAL TERM" "$OUT2/events.log"
check "its box directory is gone" no_run_dirs
check "its agent is gone too" bash -c '[ -z "$1" ]' _ "$(as_user 'for p in /proc/[0-9]*; do [ "$(tr "\0" " " <$p/cmdline 2>/dev/null)" = "bash agent.sh " ] && echo $p; done; true')"

# --- the agent's floor -----------------------------------------------------------------------------------------------
AVAIL="$(as_user "awk '/^MemAvailable:/{print \$2}' /proc/meminfo")"
FLOOR=$((AVAIL - 60 * 1024))
info "the agent alone, floor $((FLOOR / 1024)) MB with $((AVAIL / 1024)) MB available ..."
as_user "mkdir -p /tmp/rj-capacity-floor && cat >/tmp/rj-capacity-floor/agent.sh" <"$DRILLS/capacity_agent.sh"
as_user "cd /tmp/rj-capacity-floor && RUN_DIR=/tmp/rj-capacity-floor BIN=$WIRE_DIR/server.x86_64 PORTS='8102 8103' \
  PHASES='m1:1:60' INTERVAL=1 FLOOR_KB=$FLOOR EST_KB=1 BRAINS='' bash agent.sh"; RC=$?
EV="$(as_user 'cat /tmp/rj-capacity-floor/events.log')"
echo "$EV" | sed 's/^/    /'
check "the agent exits 3 on the floor" [ "$RC" = 3 ]
check "a server had started before the floor was crossed" bash -c 'grep -q " START " <<<"$1" && grep -q " ABORT MemAvailable" <<<"$1"' _ "$EV"
check "no server is left after the floor" bash -c '[ -z "$1" ]' _ "$(our_servers)"
as_user "rm -rf /tmp/rj-capacity-floor"
