#!/usr/bin/env bash
# The box side of ops/drills/measure_capacity.sh (RJ 484); not for use on its own. measure_capacity.sh uploads it to
# $RUN_DIR and starts it detached (setsid nohup), so it runs its whole plan, and stops every server it started, whether
# or not the Mac stays connected.
#
# Every setting comes from the environment (measure_capacity.sh sets them all):
#   RUN_DIR      its directory: samples.csv, events.log, pids, server logs; a file named "stop" in it ends the run early
#   BIN          the game server binary, run from its own directory the brain's way
#   PORTS        UDP ports it may use, space-separated
#   PHASES       "name:matches:seconds ..." in order, e.g. "idle:0:60 m1:1:180 m2:2:180 m3:3:180 cool:0:60"
#   INTERVAL     seconds between samples
#   FLOOR_KB     MemAvailable below this ends the run at once (every server killed)
#   EST_KB       a server's memory, assumed before one has been measured, for the headroom check before each start
#   WARMUP_SEC   how long a new match may take to reach INGAME; its samples are marked unsettled meanwhile
#   BRAINS       "name=pattern;..." -- a process whose command line contains the pattern is sampled as that name
#   SERVER_ARGS  the server's arguments besides --port
#   REMATCH_SEC  how long after a match's POSTGAME its server is replaced by a fresh one (bots ready up only on arrival,
#                so a server left alone idles in PREGAME after its first match)
#
# samples.csv, one row per process per sample and one "box" row: process cpu_pct is percent of one core over the
# interval (from /proc/<pid>/stat), box_cpu_pct / steal_pct / iowait_pct are percent of all cores (/proc/stat). A
# server row's state is "ingame" between its INGAME and POSTGAME lines, "between" otherwise.
# Everything is read from /proc, with shell builtins wherever possible, so the sampler itself costs next to nothing.
set -u

: "${RUN_DIR:?}" "${BIN:?}" "${PORTS:?}" "${PHASES:?}" "${INTERVAL:?}" "${FLOOR_KB:?}" "${EST_KB:?}"
: "${WARMUP_SEC:=40}" "${REMATCH_SEC:=8}" "${BRAINS:=}" "${SERVER_ARGS:=--net_env=dev --open_mode --bots=3 --bot_difficulty=Hard}"

cd "$RUN_DIR" || exit 1
EVENTS="$RUN_DIR/events.log"
CSV="$RUN_DIR/samples.csv"
PIDFILE="$RUN_DIR/pids"
BIN_DIR="$(dirname "$BIN")"
BIN_NAME="$(basename "$BIN")"
T0="$(date +%s)"
: >"$PIDFILE"
echo "$$" >"$RUN_DIR/agent.pid"

event() { echo "$(date +%s) $(( $(date +%s) - T0 )) $*" >>"$EVENTS"; }

# The plan's length, warm-ups and a minute's margin included: every server runs under `timeout` to here, so even an
# agent that is SIGKILLed leaves nothing running past it.
TOTAL=60
for ph in $PHASES; do
  IFS=: read -r _ _ secs <<<"$ph"
  TOTAL=$((TOTAL + secs + WARMUP_SEC))
done
DEADLINE=$((T0 + TOTAL))

# --- the servers it started: slot -> timeout's pid, the server's pid, its port, its log -----------------------------
declare -a S_TPID=() S_PID=() S_PORT=() S_LOG=() S_START=() S_SEEN=() S_ENDED=() S_ENDAT=()
NEXT_LOG=0
MATCHES_ENDED=0
EXITS=0

port_busy() {
  local hex
  hex="$(printf '%04X' "$1")"
  awk -v p=":$hex" 'NR > 1 && substr($2, length($2) - 4) == p { f = 1 } END { exit !f }' /proc/net/udp /proc/net/udp6 2>/dev/null
}
port_taken_by_us() {
  local i
  for i in "${!S_PORT[@]}"; do [ "${S_PORT[$i]}" = "$1" ] && [ -n "${S_TPID[$i]}" ] && return 0; done
  return 1
}
free_port() {
  local p
  for p in $PORTS; do
    port_taken_by_us "$p" && continue
    port_busy "$p" && continue
    echo "$p"; return 0
  done
  return 1
}

# The server is timeout's child: env execs timeout, which forks the server.
child_of() {
  local parent="$1" f kids line rest st
  f="/proc/$parent/task/$parent/children"
  if [ -r "$f" ]; then
    read -r kids _ <"$f" 2>/dev/null && { echo "$kids"; return 0; }
  fi
  for f in /proc/[0-9]*/stat; do
    read -r line <"$f" 2>/dev/null || continue
    rest="${line##*) }"
    read -r -a st <<<"$rest"
    [ "${st[1]:-}" = "$parent" ] && { f="${f#/proc/}"; echo "${f%/stat}"; return 0; }
  done
  return 1
}

start_server() {
  local slot="$1" port log left
  port="$(free_port)" || { event "SKIP slot $slot: no free port among $PORTS"; return 1; }
  left=$((DEADLINE - $(date +%s)))
  [ "$left" -gt 30 ] || { event "SKIP slot $slot: past the deadline"; return 1; }
  NEXT_LOG=$((NEXT_LOG + 1))
  log="$RUN_DIR/server-$port-$NEXT_LOG.log"
  # shellcheck disable=SC2086 # SERVER_ARGS is a list of words
  ( cd "$BIN_DIR" && exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" USER="${USER:-rj}" LANG=C.UTF-8 \
      timeout -s KILL "$left" "./$BIN_NAME" --port="$port" $SERVER_ARGS ) >"$log" 2>&1 &
  local tpid=$! spid="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    spid="$(child_of "$tpid")" && break
    sleep 0.2
  done
  S_TPID[slot]="$tpid"; S_PID[slot]="${spid:-}"; S_PORT[slot]="$port"; S_LOG[slot]="$log"
  S_START[slot]="$(date +%s)"; S_SEEN[slot]=0; S_ENDED[slot]=0; S_ENDAT[slot]=0
  echo "$tpid ${spid:-}" >>"$PIDFILE"
  event "START slot $slot port $port server pid ${spid:-?} (timeout pid $tpid, ${left}s cap) log $(basename "$log")"
}

stop_slot() {
  local slot="$1" why="$2" tpid spid i
  tpid="${S_TPID[$slot]:-}"; spid="${S_PID[$slot]:-}"
  [ -n "$tpid" ] || return 0
  kill -TERM "$tpid" ${spid:+"$spid"} 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    alive "$tpid" || alive "$spid" || break
    sleep 0.2
  done
  kill -KILL "$tpid" ${spid:+"$spid"} 2>/dev/null
  wait "$tpid" 2>/dev/null
  event "STOP slot $slot port ${S_PORT[$slot]} ($why)"
  S_TPID[slot]=""; S_PID[slot]=""
}

# shellcheck disable=SC2329 # called from the EXIT trap
stop_all() {
  local i
  for i in "${!S_TPID[@]}"; do stop_slot "$i" "$1"; done
  # Belt and braces: anything ever recorded in pids that is still a server of ours.
  local tp sp
  while read -r tp sp; do
    for p in $tp $sp; do
      [ -n "$p" ] && kill -0 "$p" 2>/dev/null && grep -qa -- "$BIN_NAME" "/proc/$p/cmdline" 2>/dev/null && kill -KILL "$p" 2>/dev/null
    done
  done <"$PIDFILE"
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

running_count() {
  local n=0 i
  for i in "${!S_TPID[@]}"; do [ -n "${S_TPID[$i]}" ] && n=$((n + 1)); done
  echo "$n"
}

FINISHED=0
# shellcheck disable=SC2329 # the EXIT trap's
on_exit() {
  [ "$FINISHED" = 1 ] && return
  FINISHED=1
  stop_all "the agent is exiting"
  event "DONE matches_ended=$MATCHES_ENDED server_exits=$EXITS"
}
trap on_exit EXIT
trap 'event "SIGNAL TERM"; exit 4' TERM
trap 'event "SIGNAL INT"; exit 4' INT
trap '' HUP PIPE

# --- sampling ------------------------------------------------------------------------------------------------------
declare -A PREV_TICKS=() PREV_AT=()
declare -A WATCH=()   # name -> pid, the processes sampled besides our servers
PREV_UP=0; PREV_TOTAL=0; PREV_IDLE=0; PREV_IOW=0; PREV_STEAL=0; PREV_SWIN=0; PREV_SWOUT=0; LAST_SCAN=0
MEASURED_KB=0
MARGINAL_KB=0
IDLE_AVAIL=0
MEM_AVAIL=0

# One grep over every command line per name; grep's own command line names the pattern, so it is filtered out by comm.
find_pids() {
  local pattern="$1" f p comm out=""
  # shellcheck disable=SC2013 # /proc/<pid>/cmdline paths have no spaces
  for f in $(grep -laF -- "$pattern" /proc/[0-9]*/cmdline 2>/dev/null); do
    p="${f#/proc/}"; p="${p%/cmdline}"
    read -r comm <"/proc/$p/comm" 2>/dev/null || continue
    [ "$comm" = grep ] && continue
    [ "$p" = "$$" ] && continue
    # A shell whose command line merely names the pattern (a launcher's `bash -c "... BRAINS=..."`) is not the process.
    grep -qaF "BRAINS=" "/proc/$p/cmdline" 2>/dev/null && continue
    out="$out $p"
  done
  echo "$out"
}

scan() {
  WATCH=()
  local entry name pattern p ours i
  IFS=';' read -r -a entries <<<"$BRAINS"
  for entry in "${entries[@]}"; do
    [ -n "$entry" ] || continue
    name="${entry%%=*}"; pattern="${entry#*=}"
    for p in $(find_pids "$pattern"); do
      if [ -z "${WATCH[$name]:-}" ]; then WATCH[$name]="$p"; else WATCH["$name.$p"]="$p"; fi
    done
  done
  # Game servers nobody here started (a brain's lobbies): counted, so a figure is never silently someone else's.
  for p in $(find_pids "$BIN_NAME"); do
    ours=0
    for i in "${!S_PID[@]}"; do
      if [ "${S_PID[$i]}" = "$p" ] || [ "${S_TPID[$i]}" = "$p" ]; then ours=1; fi
    done
    [ "$ours" = 1 ] && continue
    read -r comm <"/proc/$p/comm" 2>/dev/null || continue
    [ "$comm" = timeout ] && continue
    WATCH["other-server.$p"]="$p"
  done
  LAST_SCAN="$(date +%s)"
}

# proc_row <who> <pid> <now centiseconds>: one CSV row for a process; also sets ROW_RSS.
ROW_RSS=0
proc_row() {
  local who="$1" pid="$2" up="$3" ROW_STATE="${4:-}" line rest k v _ rss=0 hwm=0 swp=0 ticks cpu="" dt
  read -r line <"/proc/$pid/stat" 2>/dev/null || return 1
  rest="${line##*) }"
  read -r -a f <<<"$rest"
  ticks=$(( f[11] + f[12] ))
  while read -r k v _; do
    case "$k" in
      VmRSS:) rss="$v" ;;
      VmHWM:) hwm="$v" ;;
      VmSwap:) swp="$v" ;;
    esac
  done <"/proc/$pid/status" 2>/dev/null
  if [ -n "${PREV_TICKS[$pid]:-}" ]; then
    dt=$(( up - PREV_AT[$pid] ))
    [ "$dt" -gt 0 ] && cpu="$(pct10 $(( (ticks - PREV_TICKS[$pid]) * 1000 / dt )))"
  fi
  PREV_TICKS[$pid]="$ticks"; PREV_AT[$pid]="$up"
  ROW_RSS="$rss"
  echo "$NOW,$((NOW - T0)),$PHASE,$RUNNING,$SETTLED,$who,$pid,$rss,$hwm,$swp,$cpu,,,,,,,,,$ROW_STATE"
}
pct10() { local x="$1"; [ "$x" -lt 0 ] && x=0; echo "$((x / 10)).$((x % 10))"; }

sample() {
  local up upcs k v _ total=0 cpu_line idle iow steal busy dt memtotal=0 swt=0 swf=0 l1 boxcpu="" stealp="" iowp=""
  local swin=0 swout=0 swin_r="" swout_r="" name i st
  NOW="$(date +%s)"
  RUNNING=0
  for i in "${!S_TPID[@]}"; do [ -n "${S_TPID[$i]}" ] && RUNNING=$((RUNNING + 1)); done
  read -r up _ </proc/uptime; upcs="${up/./}"; upcs=$((10#$upcs))
  [ $((NOW - LAST_SCAN)) -ge 30 ] && scan
  # Box.
  while read -r k v _; do
    case "$k" in
      MemTotal:) memtotal="$v" ;;
      MemAvailable:) MEM_AVAIL="$v" ;;
      SwapTotal:) swt="$v" ;;
      SwapFree:) swf="$v" ;;
    esac
  done </proc/meminfo
  read -r l1 _ </proc/loadavg
  read -r -a cpu_line </proc/stat
  for v in "${cpu_line[@]:1:8}"; do total=$((total + v)); done
  idle="${cpu_line[4]}"; iow="${cpu_line[5]}"; steal="${cpu_line[8]:-0}"
  while read -r k v; do
    case "$k" in pswpin) swin="$v" ;; pswpout) swout="$v" ;; esac
  done </proc/vmstat
  if [ "$PREV_TOTAL" -gt 0 ]; then
    dt=$((total - PREV_TOTAL))
    if [ "$dt" -gt 0 ]; then
      busy=$(( dt - (idle - PREV_IDLE) - (iow - PREV_IOW) - (steal - PREV_STEAL) ))
      boxcpu="$(pct10 $(( busy * 1000 / dt )))"
      stealp="$(pct10 $(( (steal - PREV_STEAL) * 1000 / dt )))"
      iowp="$(pct10 $(( (iow - PREV_IOW) * 1000 / dt )))"
    fi
    local dsec=$(( upcs - PREV_UP ))
    if [ "$dsec" -gt 0 ]; then
      swin_r="$(pct10 $(( (swin - PREV_SWIN) * 1000 / dsec )))"   # pages per second: x100 cs, /10 for pct10's decimal
      swout_r="$(pct10 $(( (swout - PREV_SWOUT) * 1000 / dsec )))"
    fi
  fi
  PREV_TOTAL="$total"; PREV_IDLE="$idle"; PREV_IOW="$iow"; PREV_STEAL="$steal"; PREV_SWIN="$swin"; PREV_SWOUT="$swout"
  PREV_UP="$upcs"
  [ "$RUNNING" = 0 ] && IDLE_AVAIL="$MEM_AVAIL"
  {
    echo "$NOW,$((NOW - T0)),$PHASE,$RUNNING,$SETTLED,box,,$((memtotal - MEM_AVAIL)),,,,$MEM_AVAIL,$((swt - swf)),$swin_r,$swout_r,$l1,$boxcpu,$stealp,$iowp,"
    for i in "${!S_PID[@]}"; do
      [ -n "${S_PID[$i]}" ] || continue
      st=between; [ "${S_SEEN[$i]}" -gt "${S_ENDED[$i]}" ] && st=ingame
      if proc_row "server.$i" "${S_PID[$i]}" "$upcs" "$st"; then
        [ "$ROW_RSS" -gt "$MEASURED_KB" ] && MEASURED_KB="$ROW_RSS"
      fi
    done
    for name in "${!WATCH[@]}"; do
      proc_row "$name" "${WATCH[$name]}" "$upcs" || true
    done
  } >>"$CSV"
}

# Each tick: did a server exit (a match over, or a crash)? Restart it while the phase still wants it: back to back.
check_servers() {
  local i tpid rc n
  for i in "${!S_TPID[@]}"; do
    tpid="${S_TPID[$i]}"
    [ -n "$tpid" ] || continue
    # A server with --bots plays match after match on its own: PREGAME, INGAME, POSTGAME, PREGAME, ...
    n="$(grep -c '^INGAME$' "${S_LOG[$i]}" 2>/dev/null)"; n="${n:-0}"
    if [ "$n" -gt "${S_SEEN[$i]}" ]; then
      event "INGAME slot $i port ${S_PORT[$i]} ($((NOW - S_START[i]))s after its start; match $n of this server)"
      S_SEEN[i]="$n"
    fi
    n="$(grep -c '^POSTGAME$' "${S_LOG[$i]}" 2>/dev/null)"; n="${n:-0}"
    if [ "$n" -gt "${S_ENDED[$i]}" ]; then
      MATCHES_ENDED=$((MATCHES_ENDED + n - S_ENDED[i]))
      event "POSTGAME slot $i port ${S_PORT[$i]} (match $n of this server ended after $((NOW - S_START[i]))s; $MATCHES_ENDED in all)"
      S_ENDED[i]="$n"; S_ENDAT[i]="$NOW"
    fi
    # Bots ready up only on arrival, so after a match the server idles in PREGAME: restart it for the next match.
    if [ "${S_ENDAT[$i]}" -gt 0 ] && [ "${S_SEEN[$i]}" -le "${S_ENDED[$i]}" ] && [ $((NOW - S_ENDAT[i])) -ge "$REMATCH_SEC" ]; then
      stop_slot "$i" "its match is over: a fresh server for the next"
      if [ "$i" -lt "$WANT" ] && headroom_ok; then start_server "$i"; fi
      continue
    fi
    if ! kill -0 "$tpid" 2>/dev/null; then
      wait "$tpid" 2>/dev/null; rc=$?
      EXITS=$((EXITS + 1))
      event "EXIT slot $i port ${S_PORT[$i]} status $rc after $((NOW - S_START[i]))s; last line: $(tail -n 1 "${S_LOG[$i]}" 2>/dev/null | tr -d '\r' | cut -c1-120)"
      S_TPID[i]=""; S_PID[i]=""
      [ "$i" -lt "$WANT" ] && headroom_ok && start_server "$i"
    fi
  done
}

headroom_ok() {
  # What a match costs: the fall in MemAvailable per running match since the idle baseline (servers share the binary's
  # pages, so this is less than a server's RSS), x1.2; before any is measured, EST_KB.
  local est="$EST_KB" running
  running="$(running_count)"
  if [ "$running" -gt 0 ] && [ "$IDLE_AVAIL" -gt 0 ]; then
    local per=$(( (IDLE_AVAIL - MEM_AVAIL) / running ))
    [ "$per" -gt "$MARGINAL_KB" ] && MARGINAL_KB="$per"
  fi
  [ "$MARGINAL_KB" -gt 0 ] && est=$((MARGINAL_KB * 12 / 10))
  if [ $((MEM_AVAIL - est)) -lt "$FLOOR_KB" ]; then
    event "SKIP a server start: MemAvailable $((MEM_AVAIL / 1024)) MB less an estimated $((est / 1024)) MB would cross the $((FLOOR_KB / 1024)) MB floor"
    return 1
  fi
  return 0
}

guard() {
  if [ "$MEM_AVAIL" -lt "$FLOOR_KB" ]; then
    event "ABORT MemAvailable $((MEM_AVAIL / 1024)) MB is under the $((FLOOR_KB / 1024)) MB floor: stopping every server"
    exit 3
  fi
  if [ -e "$RUN_DIR/stop" ]; then
    event "ABORT a stop was asked for"
    exit 5
  fi
}

# --- the plan ------------------------------------------------------------------------------------------------------
echo "t,elapsed_s,phase,matches,settled,who,pid,rss_kb,peak_kb,swap_kb,cpu_pct,avail_kb,swap_used_kb,swapin_pps,swapout_pps,load1,box_cpu_pct,steal_pct,iowait_pct,state" >"$CSV"
event "BEGIN binary $BIN ports [$PORTS] phases [$PHASES] interval ${INTERVAL}s floor $((FLOOR_KB / 1024)) MB deadline +${TOTAL}s"
PHASE=start; WANT=0; SETTLED=0; RUNNING=0
scan
sample   # primes the CPU counters; its CPU columns are empty

for ph in $PHASES; do
  IFS=: read -r PHASE WANT secs <<<"$ph"
  SETTLED=0
  event "PHASE $PHASE: $WANT match(es) for ${secs}s"
  # Down to WANT: stop the highest slots first.
  for i in "${!S_TPID[@]}"; do
    [ "$i" -ge "$WANT" ] && [ -n "${S_TPID[$i]}" ] && stop_slot "$i" "phase $PHASE wants $WANT"
  done
  # Up to WANT, one at a time, each only with headroom; each new match warms up before the next starts.
  for ((i = 0; i < WANT; i++)); do
    [ -n "${S_TPID[$i]:-}" ] && continue
    sample; guard
    headroom_ok || break
    start_server "$i" || break
    w0="$(date +%s)"
    while [ $(( $(date +%s) - w0 )) -lt "$WARMUP_SEC" ]; do
      sleep "$INTERVAL"
      sample; guard; check_servers
      [ "${S_SEEN[$i]:-0}" -gt 0 ] && break
    done
    [ "${S_SEEN[$i]:-0}" -gt 0 ] || event "WARN slot $i: no INGAME within ${WARMUP_SEC}s"
  done
  [ "$(running_count)" -lt "$WANT" ] && event "WARN phase $PHASE runs $(running_count) of $WANT match(es)"
  SETTLED=1
  p0="$(date +%s)"
  while [ $(( $(date +%s) - p0 )) -lt "$secs" ]; do
    sleep "$INTERVAL"
    sample; guard; check_servers
  done
done
PHASE=end; SETTLED=0
exit 0
