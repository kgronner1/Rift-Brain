#!/usr/bin/env bash
# Runs the box's metrics reporter (RJ 487, infra/box/report_metrics.sh) and provision.sh's metrics step in Docker, on
# the box's own Amazon Linux release, with a fake `aws` that records its arguments and a fake `systemctl`.
#
#   bash infra/test/report_metrics.sh
#
# Grades: the reporter sends MemAvailableMB and SwapUsedMB from a given /proc/meminfo; counts game servers per
# environment by command line, anchored (a shell that only mentions the path is not counted), and a total; sends 0 when
# none run; refuses without a region; fails when aws fails (so systemd logs a failed run). systemd-analyze verifies both
# units. provision.sh's metrics step: PLAN writes nothing; --apply installs the script and units and enables the timer;
# a re-run changes nothing and reloads nothing; a changed unit reloads and restarts the timer.
# Needs Docker. The container is removed on every exit path.
set -euo pipefail

if [ "${1:-}" != --inside ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  IMAGE="${AL2023_IMAGE:-amazonlinux:2023.5.20240819.0}"
  NAME="rj-report-metrics-$$"
  trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
  docker run --rm --name "$NAME" --platform linux/amd64 -v "$REPO_DIR/infra:/infra:ro" \
    "$IMAGE" bash /infra/test/report_metrics.sh --inside
  exit
fi

# --- inside the container ----------------------------------------------------------------------------------------
PASSES=0
pass() { echo "PASS $*"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*"; exit 1; }

dnf -y -q install procps-ng systemd diffutils findutils python3 >/dev/null

T="$(mktemp -d)"
mkdir -p "$T/bin" "$T/rj"
# The fake aws: one line of arguments per call, NUL-free; RJ_FAKE_AWS_FAIL makes it fail.
cat >"$T/bin/aws" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_AWS_LOG"
[ -z "${RJ_FAKE_AWS_FAIL:-}" ] || { echo "An error occurred (AccessDenied)" >&2; exit 254; }
EOF
chmod +x "$T/bin/aws"
export FAKE_AWS_LOG="$T/aws.log"
cat >"$T/meminfo" <<'EOF'
MemTotal:         971876 kB
MemFree:           97280 kB
MemAvailable:     541696 kB
SwapCached:         1024 kB
SwapTotal:       3145724 kB
SwapFree:        3034108 kB
EOF
REPORT=(env RJ_ROOT="$T/rj" RJ_MEMINFO="$T/meminfo" RJ_AWS="$T/bin/aws" AWS_REGION=us-west-1 bash /infra/box/report_metrics.sh)

# --- no game servers ---------------------------------------------------------------------------------------------
out="$("${REPORT[@]}")" || fail "the reporter failed with nothing running: $out"
line="$(tail -n 1 "$FAKE_AWS_LOG")"
[[ "$line" == "--no-cli-pager cloudwatch put-metric-data --region us-west-1 --namespace RiftJumpers/Box --metric-data "* ]] \
  || fail "unexpected aws call: $line"
json="${line#*--metric-data }"
python3 -c 'import json,sys; json.loads(sys.argv[1])' "$json" || fail "the metric data is not JSON: $json"
pass "one put-metric-data call to RiftJumpers/Box in us-west-1, with valid JSON"
grep -q '"MetricName":"MemAvailableMB","Value":529,"Unit":"Megabytes"}' <<<"$json" || fail "MemAvailableMB is not 529: $json"
grep -q '"MetricName":"SwapUsedMB","Value":109,"Unit":"Megabytes"}' <<<"$json" || fail "SwapUsedMB is not 109: $json"
pass "MemAvailableMB 529 and SwapUsedMB 109 from meminfo"
grep -q '"MetricName":"ActiveMatches","Value":0,"Unit":"Count"}' <<<"$json" || fail "no total of 0: $json"
grep -q '"Value":0,"Unit":"Count","Dimensions":\[{"Name":"Env","Value":"dev"}\]' <<<"$json" || fail "no dev 0: $json"
grep -q '"Value":0,"Unit":"Count","Dimensions":\[{"Name":"Env","Value":"alpha"}\]' <<<"$json" || fail "no alpha 0: $json"
pass "ActiveMatches 0 (total, dev, alpha) with nothing running: $out"

# --- three game servers and a decoy ------------------------------------------------------------------------------
# A copy of bash stands in for the server (coreutils here is one multi-call binary, which will not run renamed).
for d in dev/servers/wire-2-x alpha/servers/wire-2-x; do mkdir -p "$T/rj/$d"; cp /usr/bin/bash "$T/rj/$d/server.x86_64"; done
# As the brain starts them: /bin/sh -c 'ulimit -c 0 && exec "$0" "$@"' <binary> <args> (src/match/host.js).
for d in dev dev alpha; do
  /bin/sh -c 'ulimit -c 0 && exec "$0" "$@"' "$T/rj/$d/servers/wire-2-x/server.x86_64" -c 'sleep 300; :' &
done
# A shell that only mentions the path, as an ssh command or a pgrep would.
bash -c "sleep 300; : $T/rj/dev/servers/" &
sleep 1
"${REPORT[@]}" >/dev/null || fail "the reporter failed with servers running"
json="$(tail -n 1 "$FAKE_AWS_LOG")"
grep -q '"Value":2,"Unit":"Count","Dimensions":\[{"Name":"Env","Value":"dev"}\]' <<<"$json" || fail "dev is not 2: $json"
grep -q '"Value":1,"Unit":"Count","Dimensions":\[{"Name":"Env","Value":"alpha"}\]' <<<"$json" || fail "alpha is not 1: $json"
grep -q '"MetricName":"ActiveMatches","Value":3,"Unit":"Count"}' <<<"$json" || fail "the total is not 3: $json"
pass "ActiveMatches dev 2, alpha 1, total 3; the shell that mentions the path is not counted"
jobs -p | xargs -r kill 2>/dev/null || true

# --- failures ----------------------------------------------------------------------------------------------------
if out="$(env RJ_ROOT="$T/rj" RJ_MEMINFO="$T/meminfo" RJ_AWS="$T/bin/aws" bash /infra/box/report_metrics.sh 2>&1)"; then
  fail "the reporter ran without a region (no AWS_REGION, no instance metadata)"
fi
grep -q 'no region' <<<"$out" || fail "no region: unexpected message: $out"
pass "refuses without a region: $out"
if RJ_FAKE_AWS_FAIL=1 "${REPORT[@]}" >/dev/null 2>&1; then fail "the reporter succeeded although aws failed"; fi
pass "fails when aws fails"

# --- the units ---------------------------------------------------------------------------------------------------
install -m 0755 /infra/box/report_metrics.sh /usr/local/bin/rj-report-metrics
cp /infra/box/rj-metrics.service /infra/box/rj-metrics.timer /etc/systemd/system/
out="$(systemd-analyze verify /etc/systemd/system/rj-metrics.service /etc/systemd/system/rj-metrics.timer 2>&1)" \
  || fail "systemd-analyze verify: $out"
[ -z "$(grep -i 'rj-metrics' <<<"$out" || true)" ] || fail "systemd-analyze verify warns: $out"
next="$(systemd-analyze calendar '*:0/5:30' | sed -n 's/^ *Next elapse: //p')"
[ -n "$next" ] || fail "the timer's OnCalendar does not parse"
pass "both units verify; the timer next fires $next"
rm -f /usr/local/bin/rj-report-metrics /etc/systemd/system/rj-metrics.*

# --- provision.sh's metrics step ---------------------------------------------------------------------------------
cat >"$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
case "$*" in
  "is-enabled --quiet rj-metrics.timer"|"is-active --quiet rj-metrics.timer") [ -f "$FAKE_SYSTEMCTL_LOG.enabled" ] ;;
  "enable --now rj-metrics.timer") touch "$FAKE_SYSTEMCTL_LOG.enabled" ;;
esac
EOF
# provision.sh sudoes; the container is root already, and a real sudo would reset PATH past the fake systemctl.
printf '#!/usr/bin/env bash\nexec "$@"\n' >"$T/bin/sudo"
chmod +x "$T/bin/systemctl" "$T/bin/sudo"
export FAKE_SYSTEMCTL_LOG="$T/systemctl.log"
UNITS="$T/units"
mkdir -p "$UNITS"
PROVISION=(env PATH="$T/bin:$PATH" RJ_PROVISION_STEPS=metrics RJ_SYSTEMD_DIR="$UNITS"
  RJ_METRICS_BIN="$T/rj-report-metrics" bash /infra/box/provision.sh --env dev --ref HEAD)

out="$("${PROVISION[@]}" 2>&1)" || fail "provision PLAN failed: $out"
[ ! -e "$T/rj-report-metrics" ] && [ -z "$(ls "$UNITS")" ] || fail "PLAN wrote something"
grep -q 'PLAN: systemctl enable --now rj-metrics.timer' <<<"$out" || fail "PLAN does not name the timer: $out"
grep -q 'WARNING: the instance has no IAM role' <<<"$out" || fail "PLAN does not warn about the missing role: $out"
pass "PLAN writes nothing, names the timer, and warns that there is no instance role"

: >"$FAKE_SYSTEMCTL_LOG"
out="$("${PROVISION[@]}" --apply 2>&1)" || fail "provision --apply failed: $out"
cmp -s /infra/box/report_metrics.sh "$T/rj-report-metrics" && [ -x "$T/rj-report-metrics" ] || fail "the script is not installed"
for u in rj-metrics.service rj-metrics.timer; do cmp -s "/infra/box/$u" "$UNITS/$u" || fail "$u is not installed"; done
for c in 'daemon-reload' 'enable --now rj-metrics.timer'; do
  grep -qx -- "$c" "$FAKE_SYSTEMCTL_LOG" || fail "--apply did not run systemctl $c: $(cat "$FAKE_SYSTEMCTL_LOG")"
done
pass "--apply installs the script and both units, reloads systemd and enables the timer"

: >"$FAKE_SYSTEMCTL_LOG"
out="$("${PROVISION[@]}" --apply 2>&1)" || fail "the re-run failed: $out"
! grep -Eqx 'daemon-reload|enable .*|restart .*' "$FAKE_SYSTEMCTL_LOG" || fail "the re-run changed something: $(cat "$FAKE_SYSTEMCTL_LOG")"
grep -q 'rj-metrics.timer is enabled and running' <<<"$out" || fail "the re-run does not say the timer runs: $out"
pass "a re-run writes nothing, reloads nothing and restarts nothing"

echo "# changed" >>"$UNITS/rj-metrics.timer"
: >"$FAKE_SYSTEMCTL_LOG"
"${PROVISION[@]}" --apply >/dev/null 2>&1 || fail "the run after a unit change failed"
for c in 'daemon-reload' 'restart rj-metrics.timer'; do
  grep -qx -- "$c" "$FAKE_SYSTEMCTL_LOG" || fail "a changed unit did not run systemctl $c: $(cat "$FAKE_SYSTEMCTL_LOG")"
done
cmp -s /infra/box/rj-metrics.timer "$UNITS/rj-metrics.timer" || fail "the changed unit was not put back"
pass "a changed unit is put back, systemd reloaded and the timer restarted"

echo "report_metrics: $PASSES passed"
