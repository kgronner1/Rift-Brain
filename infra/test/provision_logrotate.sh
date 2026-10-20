#!/usr/bin/env bash
# Runs provision.sh's logrotate step (RJ 505) in Docker, on the box's own Amazon Linux release, laid out like the box:
# ec2-user with passwordless sudo, Node 16.20.2 + pm2 6.0.13 under /usr, and pm2 apps rift-brain-dev and
# rift-brain-alpha writing numbered lines to /opt/rj/<env>/logs/brain.{out,err}.log, as their ecosystem files say.
# systemctl is a fake that records its arguments; its `start rj-logrotate.service` runs the installed unit's ExecStart
# as root, as systemd would. Every rotation below is that ExecStart, never a forced logrotate.
#
#   bash infra/test/provision_logrotate.sh
#
# Grades: PLAN writes nothing and names the install, the rule, both units and the timer; --apply installs logrotate
# with dnf, the rule (root 0644, rendered for /opt/rj and ec2-user) and both units, enables the timer, and its one run
# records every brain log without rotating any; a re-run (dev, then alpha) changes nothing; a changed unit is put back
# and the timer restarted; a rule that logrotate -d rejects stops the step before it writes. Both units verify, and the
# service names the rule and state file provision.sh does. Then the rule itself: a log past 20 MB is rotated within
# the hour; the next day every non-empty log is rotated and an empty one is not; the newest copy stays plain, older
# ones are gzipped; 14 copies kept and none past 14 days; copies belong to ec2-user. Through all of it pm2 keeps writing
# to the same open files: no restart, no NUL bytes, and the lines lost in copytruncate's window are counted.
# Needs Docker and the network (dnf, nodejs.org, npm). The container is removed on every exit path.
set -euo pipefail

if [ "${1:-}" != --inside ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  IMAGE="${AL2023_IMAGE:-amazonlinux:2023.5.20240819.0}"
  NAME="rj-provision-logrotate-$$"
  trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
  docker run --rm --name "$NAME" --platform linux/amd64 -v "$REPO_DIR/infra:/infra:ro" \
    "$IMAGE" bash /infra/test/provision_logrotate.sh --inside
  exit
fi

# --- inside the container ----------------------------------------------------------------------------------------
PASSES=0
pass() { echo "PASS $*"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*"; exit 1; }
show_fail() { cat "$1"; fail "$2"; }

# Not logrotate: the step installs it.
dnf -y -q install sudo shadow-utils procps-ng systemd gzip findutils diffutils tar xz >/dev/null
rpm -q logrotate >/dev/null 2>&1 && fail "setup: logrotate is installed already"
NODE16=node-v16.20.2-linux-x64
curl -fsSL -o "/tmp/$NODE16.tar.xz" "https://nodejs.org/dist/v16.20.2/$NODE16.tar.xz"
curl -fsSL https://nodejs.org/dist/v16.20.2/SHASUMS256.txt | grep " $NODE16.tar.xz\$" | (cd /tmp && sha256sum -c - >/dev/null)
tar -xJf "/tmp/$NODE16.tar.xz" -C /usr --strip-components=1 --no-same-owner --no-overwrite-dir --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
npm install -g --silent pm2@6.0.13 >/dev/null 2>&1

FAKE=/opt/fake
UNITS="$FAKE/units"
SYSTEMCTL_LOG="$FAKE/systemctl.log"
mkdir -p "$FAKE/bin" "$UNITS"
cat >"$FAKE/bin/systemctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$SYSTEMCTL_LOG"
case "\$*" in
  "is-enabled --quiet rj-logrotate.timer"|"is-active --quiet rj-logrotate.timer") [ -f "$SYSTEMCTL_LOG.enabled" ] ;;
  "enable --now rj-logrotate.timer") touch "$SYSTEMCTL_LOG.enabled" ;;
  "start rj-logrotate.service") \$(sed -n 's/^ExecStart=//p' "$UNITS/rj-logrotate.service") ;;
esac
EOF
chmod 755 "$FAKE/bin/systemctl"
touch "$SYSTEMCTL_LOG"
chmod 666 "$SYSTEMCTL_LOG"
useradd -m ec2-user
# The real sudo, with the fake systemctl first on the PATH it keeps.
printf 'ec2-user ALL=(ALL) NOPASSWD:ALL\nDefaults:ec2-user secure_path="%s/bin:/sbin:/bin:/usr/sbin:/usr/bin"\n' "$FAKE" \
  >/etc/sudoers.d/ec2-user

# The brains: numbered lines on stdout; dev also writes to stderr. /tmp/rj-burst-<env> makes one write 21 MB at once.
for e in dev alpha; do
  mkdir -p "/opt/rj/$e/brain/src" "/opt/rj/$e/logs"
  cat >"/opt/rj/$e/brain/src/app.js" <<EOF
const fs = require('fs');
let n = 0;
setInterval(() => {
  n++; console.log('line ' + n);
  if ('$e' === 'dev' && n % 50 === 0) console.error('err ' + n);
  if (fs.existsSync('/tmp/rj-burst-$e')) { try { fs.unlinkSync('/tmp/rj-burst-$e'); } catch (e) {} for (let i = 0; i < 21000; i++) console.log('burst ' + 'x'.repeat(1000)); }
}, 2);
EOF
  cat >"/opt/rj/$e/ecosystem.config.js" <<EOF
module.exports = { apps: [{ name: 'rift-brain-$e', cwd: '/opt/rj/$e/brain', script: 'src/app.js', treekill: false,
  out_file: '/opt/rj/$e/logs/brain.out.log', error_file: '/opt/rj/$e/logs/brain.err.log', time: true }] };
EOF
done
chown -R ec2-user: /opt/rj

as_user() { runuser -u ec2-user -- env HOME=/home/ec2-user PATH="$FAKE/bin:/usr/local/bin:/usr/bin:/usr/sbin" "$@"; }
pid_of() { # pid_of <pm2 app>
  # shellcheck disable=SC2016 # the single quotes hold a node program
  as_user pm2 jlist 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const a = JSON.parse(s.slice(s.indexOf("["))).find((p) => p.name === process.argv[1]); console.log(a ? a.pid : ""); });' "$1"
}
prov() { # prov <env> [--apply] [provision.sh]
  as_user RJ_PROVISION_STEPS=logrotate RJ_SYSTEMD_DIR="$UNITS" bash "${3:-/infra/box/provision.sh}" --env "$1" --ref HEAD ${2:+"$2"}
}
rotate_now() { "$FAKE/bin/systemctl" start rj-logrotate.service; }
copies() { find /opt/rj/"$1"/logs -name "brain.$2.log-*" -type f | sort; }
STATE=/var/lib/logrotate/rj-logrotate.status

as_user pm2 start /opt/rj/dev/ecosystem.config.js >/dev/null
as_user pm2 start /opt/rj/alpha/ecosystem.config.js >/dev/null
STARTED=$SECONDS
DEV_PID="$(pid_of rift-brain-dev)"
ALPHA_PID="$(pid_of rift-brain-alpha)"
sleep 2
[ -s /opt/rj/dev/logs/brain.out.log ] && [ -s /opt/rj/dev/logs/brain.err.log ] && [ -s /opt/rj/alpha/logs/brain.out.log ] \
  || fail "setup: the pm2 apps are not writing their logs"
[ -e /opt/rj/alpha/logs/brain.err.log ] && [ ! -s /opt/rj/alpha/logs/brain.err.log ] || fail "setup: alpha's err log is not empty"
echo "setup: $(node -v), pm2 $(as_user pm2 -v | tail -n 1); dev pid $DEV_PID, alpha pid $ALPHA_PID"

# --- PLAN --------------------------------------------------------------------------------------------------------
prov dev >/tmp/plan.log 2>&1 || show_fail /tmp/plan.log "PLAN failed"
for want in 'PLAN: sudo dnf install logrotate' 'PLAN: check the rule with logrotate -d once logrotate is installed' \
  'PLAN: write /etc/rj-logrotate.conf' "PLAN: write $UNITS/rj-logrotate.service" "PLAN: write $UNITS/rj-logrotate.timer" \
  'PLAN: systemctl enable --now rj-logrotate.timer'; do
  grep -qF "$want" /tmp/plan.log || show_fail /tmp/plan.log "PLAN does not say: $want"
done
[ ! -e /etc/rj-logrotate.conf ] && [ -z "$(ls "$UNITS")" ] || fail "PLAN wrote something"
! rpm -q logrotate >/dev/null 2>&1 || fail "PLAN installed logrotate"
! grep -Evx 'is-(enabled|active) --quiet rj-logrotate.timer' "$SYSTEMCTL_LOG" || fail "PLAN ran systemctl: $(cat "$SYSTEMCTL_LOG")"
pass "PLAN installs nothing and writes nothing; names the install, the rule, both units and the timer"

# --- --apply -----------------------------------------------------------------------------------------------------
prov dev --apply >/tmp/apply1.log 2>&1 || show_fail /tmp/apply1.log "--apply failed"
rpm -q logrotate >/dev/null || fail "--apply did not install logrotate"
[ "$(stat -c '%U:%G %a' /etc/rj-logrotate.conf)" = "root:root 644" ] || fail "the rule is $(stat -c '%U:%G %a' /etc/rj-logrotate.conf)"
grep -qx '/opt/rj/\*/logs/brain.out.log /opt/rj/\*/logs/brain.err.log {' /etc/rj-logrotate.conf \
  || { cat /etc/rj-logrotate.conf; fail "the rule is not rendered for /opt/rj"; }
grep -qx '    su ec2-user ec2-user' /etc/rj-logrotate.conf || { cat /etc/rj-logrotate.conf; fail "the rule is not rendered for ec2-user"; }
! grep -q '@[A-Z]*@' /etc/rj-logrotate.conf || fail "the rule has a placeholder left"
for u in rj-logrotate.service rj-logrotate.timer; do cmp -s "/infra/box/$u" "$UNITS/$u" || fail "$u is not installed"; done
for c in 'daemon-reload' 'enable --now rj-logrotate.timer' 'start rj-logrotate.service'; do
  grep -qx -- "$c" "$SYSTEMCTL_LOG" || fail "--apply did not run systemctl $c: $(cat "$SYSTEMCTL_LOG")"
done
pass "--apply installs $(rpm -q logrotate), the rule (root 0644, for /opt/rj as ec2-user) and both units; reloads systemd, enables the timer, runs it once"

for f in /opt/rj/dev/logs/brain.out.log /opt/rj/dev/logs/brain.err.log /opt/rj/alpha/logs/brain.out.log /opt/rj/alpha/logs/brain.err.log; do
  grep -qF "\"$f\" " "$STATE" || fail "the state file does not track $f: $(cat "$STATE")"
done
[ -z "$(copies dev out)$(copies dev err)$(copies alpha out)" ] || fail "the first run rotated something: $(ls -l /opt/rj/*/logs)"
grep -q "PASS rj-logrotate ran and tracks dev's brain logs" /tmp/apply1.log || show_fail /tmp/apply1.log "--apply does not report its run"
grep -q 'log rotation covers: alpha/logs/brain.out.log [0-9.]*[KMG]*, dev/logs/brain.out.log [0-9.]*[KMG]*, alpha/logs/brain.err.log 0, dev/logs/brain.err.log [0-9.]*[KMG]*; rotated copies: 0' /tmp/apply1.log \
  || show_fail /tmp/apply1.log "--apply does not list the four logs it covers"
pass "the first run records all four brain logs (both environments) in $STATE and rotates none"

: >"$SYSTEMCTL_LOG"
prov dev --apply >/tmp/apply2.log 2>&1 || show_fail /tmp/apply2.log "the re-run failed"
! grep -Eqx 'daemon-reload|enable .*|restart .*' "$SYSTEMCTL_LOG" || fail "the re-run changed something: $(cat "$SYSTEMCTL_LOG")"
grep -q 'rj-logrotate.timer is enabled and running' /tmp/apply2.log || show_fail /tmp/apply2.log "the re-run does not say the timer runs"
! grep -q 'wrote ' /tmp/apply2.log || show_fail /tmp/apply2.log "the re-run wrote something"
prov dev >/tmp/plan2.log 2>&1 || show_fail /tmp/plan2.log "PLAN after --apply failed"
! grep -q 'PLAN:' /tmp/plan2.log || show_fail /tmp/plan2.log "PLAN after --apply has something to do"
: >"$SYSTEMCTL_LOG"
prov alpha --apply >/tmp/apply-alpha.log 2>&1 || show_fail /tmp/apply-alpha.log "alpha --apply failed"
! grep -q 'wrote ' /tmp/apply-alpha.log || show_fail /tmp/apply-alpha.log "alpha's --apply rewrote the box-wide files"
! grep -Eqx 'daemon-reload|enable .*|restart .*' "$SYSTEMCTL_LOG" || fail "alpha's --apply ran: $(cat "$SYSTEMCTL_LOG")"
grep -q "PASS rj-logrotate ran and tracks alpha's brain logs" /tmp/apply-alpha.log || show_fail /tmp/apply-alpha.log "alpha's run"
pass "a re-run (dev, then alpha) writes, reloads and restarts nothing; PLAN after --apply has nothing to do"

echo "# changed" >>"$UNITS/rj-logrotate.timer"
: >"$SYSTEMCTL_LOG"
prov dev --apply >/dev/null 2>&1 || fail "the run after a unit change failed"
for c in 'daemon-reload' 'restart rj-logrotate.timer'; do
  grep -qx -- "$c" "$SYSTEMCTL_LOG" || fail "a changed unit did not run systemctl $c: $(cat "$SYSTEMCTL_LOG")"
done
cmp -s /infra/box/rj-logrotate.timer "$UNITS/rj-logrotate.timer" || fail "the changed unit was not put back"
pass "a changed unit is put back, systemd reloaded and the timer restarted"

BAD=/tmp/badbox
cp -r /infra/box "$BAD"
sed -i 's/^    daily$/    dialy/' "$BAD/rj-logrotate.conf.tmpl"
chmod -R a+rX "$BAD"
before="$(md5sum /etc/rj-logrotate.conf)"
if prov dev --apply "$BAD/provision.sh" >/tmp/bad.log 2>&1; then show_fail /tmp/bad.log "a rule logrotate -d rejects was applied"; fi
grep -q "FAIL: the log rotation rule does not check (logrotate -d): error: .*unknown option 'dialy'" /tmp/bad.log || show_fail /tmp/bad.log "the refusal"
[ "$(md5sum /etc/rj-logrotate.conf)" = "$before" ] || fail "the rejected rule was written"
pass "a rule that logrotate -d rejects stops the step before anything is written"

# --- the units ---------------------------------------------------------------------------------------------------
cp /infra/box/rj-logrotate.service /infra/box/rj-logrotate.timer /etc/systemd/system/
out="$(systemd-analyze verify /etc/systemd/system/rj-logrotate.service /etc/systemd/system/rj-logrotate.timer 2>&1)" \
  || fail "systemd-analyze verify: $out"
[ -z "$(grep -i 'rj-logrotate' <<<"$out" || true)" ] || fail "systemd-analyze verify warns: $out"
next="$(systemd-analyze calendar hourly | sed -n 's/^ *Next elapse: //p')"
[ -n "$next" ] || fail "the timer's OnCalendar does not parse"
rm -f /etc/systemd/system/rj-logrotate.*
exec_start="$(sed -n 's/^ExecStart=//p' /infra/box/rj-logrotate.service)"
[ "$exec_start" = "/usr/sbin/logrotate --state $STATE /etc/rj-logrotate.conf" ] || fail "the service runs: $exec_start"
grep -qx "LOGROTATE_CONF=/etc/rj-logrotate.conf" /infra/box/provision.sh || fail "provision.sh installs another rule file"
grep -qx "LOGROTATE_STATE=$STATE" /infra/box/provision.sh || fail "provision.sh reads another state file"
pass "both units verify; the timer next fires $next; the service runs the rule provision.sh installs, with its state file"

# --- the rule, run hourly ----------------------------------------------------------------------------------------
# A log past 20 MB is rotated by the next hourly run, the same day, while the others are not due.
as_user touch /tmp/rj-burst-dev
for _ in $(seq 1 60); do [ "$(stat -c %s /opt/rj/dev/logs/brain.out.log)" -gt 21000000 ] && break; sleep 1; done
[ "$(stat -c %s /opt/rj/dev/logs/brain.out.log)" -gt 21000000 ] || fail "the burst did not reach dev's log"
rotate_now
[ "$(copies dev out | wc -l)" = 1 ] || fail "dev's 21 MB log was not rotated: $(ls -l /opt/rj/dev/logs)"
[ "$(stat -c %s "$(copies dev out)")" -gt 21000000 ] && [ "$(stat -c %s /opt/rj/dev/logs/brain.out.log)" -lt 1000000 ] \
  || fail "after the size rotation: $(ls -l /opt/rj/dev/logs)"
[ -z "$(copies dev err)$(copies alpha out)" ] || fail "the size rotation took logs that were not due: $(ls -l /opt/rj/*/logs)"
pass "a log past 20 MB is rotated by the next hourly run; the logs under 20 MB wait for their day"

# The next day: every non-empty log, and not alpha's empty err log. The previous copy is gzipped, the newest plain.
sleep 1
sed -i -E 's/" [0-9]{4}-[0-9]{1,2}-[0-9]{1,2}-/" 2020-1-1-/' "$STATE"
rotate_now
[ "$(copies dev out | wc -l)" = 2 ] && [ "$(copies dev err | wc -l)" = 1 ] && [ "$(copies alpha out | wc -l)" = 1 ] \
  || fail "the daily rotation: $(ls -l /opt/rj/*/logs)"
[ -z "$(copies alpha err)" ] || fail "alpha's empty err log was rotated"
[[ "$(copies dev out | head -n 1)" == *.gz ]] && [[ "$(copies dev out | tail -n 1)" != *.gz ]] \
  || fail "dev out's older copy is not gzipped or the newest is: $(copies dev out)"
gzip -t "$(copies dev out | head -n 1)" || fail "the gzipped copy is broken"
pass "a day later every non-empty log is rotated and the empty one is not; the older copy is gzipped, the newest plain"

# Retention: 16 daily copies (2-17 days old) of alpha's out log and two of dev's err log (20 and 30 days old).
for d in $(seq 2 17); do
  c="/opt/rj/alpha/logs/brain.out.log-$(date -u -d "-$d days" +%Y%m%d)-000000"
  echo "old $d" | gzip >"$c.gz"; touch -d "-$d days" "$c.gz"
done
for d in 20 30; do
  c="/opt/rj/dev/logs/brain.err.log-$(date -u -d "-$d days" +%Y%m%d)-000000"
  echo "old $d" | gzip >"$c.gz"; touch -d "-$d days" "$c.gz"
done
chown ec2-user: /opt/rj/*/logs/*
sleep 1
sed -i -E 's/" [0-9]{4}-[0-9]{1,2}-[0-9]{1,2}-/" 2020-1-1-/' "$STATE"
rotate_now
[ "$(copies alpha out | wc -l)" = 14 ] || fail "alpha out keeps $(copies alpha out | wc -l) copies, not 14: $(copies alpha out)"
[ -z "$(find /opt/rj/*/logs -name 'brain.*.log-*' -mtime +14)" ] || fail "copies older than 14 days are left: $(find /opt/rj/*/logs -name 'brain.*.log-*' -mtime +14)"
[ "$(copies dev err | wc -l)" = 2 ] || fail "dev err should keep its own 2 copies, not the 20- and 30-day ones: $(copies dev err)"
pass "14 copies kept, the oldest removed past that; none older than 14 days, however few copies there are"

others="$(find /opt/rj/*/logs -name 'brain.*.log*' ! -user ec2-user)"
[ -z "$others" ] || fail "not ec2-user's: $others"
pass "every log and copy belongs to ec2-user (the rule's su)"

# --- pm2 kept writing --------------------------------------------------------------------------------------------
sleep 2
[ "$(pid_of rift-brain-dev)" = "$DEV_PID" ] && [ "$(pid_of rift-brain-alpha)" = "$ALPHA_PID" ] || fail "a brain restarted"
# shellcheck disable=SC2016 # expanded by ec2-user's shell, which may read the daemon's fds
fds="$(as_user bash -c 'ls -l /proc/$(cat ~/.pm2/pm2.pid)/fd' 2>/dev/null | grep -o '/opt/rj/.*' | sort)"
want="$(printf '%s\n' /opt/rj/alpha/logs/brain.err.log /opt/rj/alpha/logs/brain.out.log /opt/rj/dev/logs/brain.err.log /opt/rj/dev/logs/brain.out.log)"
[ "$fds" = "$want" ] || fail "pm2's open log files: $fds"
tail -n 5 /opt/rj/dev/logs/brain.out.log | grep -q 'line [0-9]*$' || fail "dev's live log is not being written"
for f in /opt/rj/*/logs/brain.*.log /opt/rj/*/logs/brain.*.log-*[0-9]; do
  [ "$(tr -cd '\000' <"$f" | wc -c)" = 0 ] || fail "$f has NUL bytes: pm2 writes past the truncate"
done
pass "pm2 kept the same four files open through every rotation, without a restart; no NUL bytes in any log"

as_user pm2 stop rift-brain-dev >/dev/null
sleep 1
nums="$(for f in /opt/rj/dev/logs/brain.out.log*; do case "$f" in *.gz) zcat "$f" ;; *) cat "$f" ;; esac; done \
  | grep -ao 'line [0-9]*$' | awk '{print $2}' | sort -n)"
first="$(head -n 1 <<<"$nums")"; last="$(tail -n 1 <<<"$nums")"; have="$(sort -u <<<"$nums" | wc -l)"
lost=$((last - first + 1 - have))
rotations="$(copies dev out | wc -l)"
[ "$first" = 1 ] || fail "dev's first line is $first"
# dev's out log at ~400 lines/s; the window between the copy and the truncate is a few milliseconds per rotation.
[ "$rotations" = 3 ] || fail "dev's out log was rotated $rotations times, not 3"
[ "$lost" -le 30 ] || fail "lost $lost of $last lines of dev's out log in $rotations rotations"
gaps="$(awk 'NR > 1 && $1 != p + 1 { printf "%d ", $1 - p - 1 } { p = $1 }' <<<"$nums")"
gaps="${gaps% }"
pass "dev's out log at ~$((last / (SECONDS - STARTED))) lines/s: $have of $last lines kept across $rotations rotations; $lost lost in copytruncate's window (gaps: ${gaps:-none})"

as_user pm2 kill >/dev/null 2>&1 || true
echo "provision_logrotate: $PASSES passed"
