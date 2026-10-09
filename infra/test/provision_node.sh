#!/usr/bin/env bash
# Runs infra/box/provision.sh's Node 20 steps (RJ 477) in Docker, on the box's own Amazon Linux release
# (amazonlinux:2023.5.20240819.0, whose repos are pinned like the box's), laid out like the box: Node 16 under /usr
# (/usr/bin/node a file, /usr/lib/node_modules a directory, /usr/bin/npm a symlink), pm2 6.0.13 installed by it, and
# three pm2 apps on it as ec2-user: rift-brain (legacy), rift-brain-dev and rift-brain-alpha, both from the ecosystem
# file provision.sh wrote before RJ 477 (no interpreter).
#
#   bash infra/test/provision_node.sh
#
# Grades: PLAN installs nothing and names the one restart, with the interpreter change; the end-of-life warning names
# the environment's node (20) only, never the system's 16; the floor refuses a node under 20; --apply installs
# nodejs20 with dnf and leaves the default node, npm, npx, /etc/npmrc and the alternatives as they were; dev restarts
# onto /usr/bin/node-20 (its process's own executable) while alpha and the legacy app keep their pids; a re-run
# installs nothing and restarts nothing; alpha then moves alone; the brain step clones this repository and runs
# npm ci with Node 20's npm on Node 20, once, and again when node_modules was installed by another Node.
# Needs Docker and the network (dnf, nodejs.org, npm). The container is removed on every exit path.
set -euo pipefail

if [ "${1:-}" != --inside ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  IMAGE="${AL2023_IMAGE:-amazonlinux:2023.5.20240819.0}"
  NAME="rj-provision-node-$$"
  GIT_COMMON="$(cd "$REPO_DIR" && cd "$(git rev-parse --git-common-dir)" && pwd)"
  REF="$(git -C "$REPO_DIR" rev-parse HEAD)"
  trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
  docker run --rm --name "$NAME" --platform linux/amd64 \
    -v "$REPO_DIR/infra:/infra:ro" -v "$GIT_COMMON:/src.git:ro" -e RJ_TEST_REF="$REF" \
    "$IMAGE" bash /infra/test/provision_node.sh --inside
  exit
fi

# --- inside the container ----------------------------------------------------------------------------------------
PASSES=0
pass() { echo "PASS $*"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL $*"; exit 1; }
show_fail() { cat "$1"; fail "$2"; }

dnf -y -q install sudo shadow-utils procps-ng iproute git tar xz findutils diffutils openssl >/dev/null
# Node 16.20.2 under /usr, checksum-verified: the layout that nodejs20's alternatives would take npm from.
NODE16=node-v16.20.2-linux-x64
curl -fsSL -o "/tmp/$NODE16.tar.xz" "https://nodejs.org/dist/v16.20.2/$NODE16.tar.xz"
curl -fsSL https://nodejs.org/dist/v16.20.2/SHASUMS256.txt | grep " $NODE16.tar.xz\$" | (cd /tmp && sha256sum -c - >/dev/null)
tar -xJf "/tmp/$NODE16.tar.xz" -C /usr --strip-components=1 --no-same-owner --no-overwrite-dir --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
npm install -g --silent pm2@6.0.13 >/dev/null 2>&1
useradd -m ec2-user
echo 'ec2-user ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/ec2-user
# MariaDB and systemd are not what this test is about: an admin connection that answers 1, and no pm2 unit.
printf '#!/bin/sh\ncase "$*" in *VERSION*) echo 10.5.25-MariaDB ;; *) echo 1 ;; esac\n' >/usr/local/bin/fake-mysql
printf '#!/bin/sh\nexit 1\n' >/usr/local/bin/systemctl
chmod 755 /usr/local/bin/fake-mysql /usr/local/bin/systemctl

for e in dev alpha; do
  mkdir -p "/opt/rj/$e/brain/src" "/opt/rj/$e/logs"
  echo 'setInterval(() => {}, 1 << 30);' >"/opt/rj/$e/brain/src/app.js"
  cat >"/opt/rj/$e/ecosystem.config.js" <<EOF
module.exports = { apps: [{ name: 'rift-brain-$e', cwd: '/opt/rj/$e/brain', script: 'src/app.js', treekill: false }] };
EOF
done
mkdir -p /home/ec2-user/legacy && cp /opt/rj/dev/brain/src/app.js /home/ec2-user/legacy/app.js
chown -R ec2-user: /opt/rj /home/ec2-user
cat >/tmp/pm2pid.js <<'EOF'
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const app = JSON.parse(s.slice(s.indexOf('['))).find((p) => p.name === process.argv[2]);
  console.log(app ? app.pid : '');
});
EOF

as_user() { runuser -u ec2-user -- env HOME=/home/ec2-user "$@"; }
pid_of() { as_user pm2 jlist 2>/dev/null | node /tmp/pm2pid.js "$1"; }
# As the apps' owner: without CAP_SYS_PTRACE, root in a container cannot read another user's /proc/<pid>/exe.
exe_of() { as_user readlink -f "/proc/$(pid_of "$1")/exe"; }
prov() { # prov <steps> <args...>
  local steps="$1"; shift
  as_user RJ_MYSQL_ADMIN=/usr/local/bin/fake-mysql RJ_PROVISION_STEPS="$steps" RJ_REPO_URL=/src.git "$@"
}
run() { prov "$1" bash /infra/box/provision.sh --ref "$RJ_TEST_REF" "${@:2}"; }
defaults() {
  for c in node npm npx; do printf '%s=%s ' "$c" "$(readlink -f "$(command -v "$c")")"; done
  stat -c '%A %N' /etc/npmrc /usr/lib/node_modules 2>&1 | tr '\n' ' '
  alternatives --list 2>/dev/null | awk '$1 ~ /^(node|npm|npx|npmrc|node_modules)$/' | tr '\n' ' '
  node -v
}

as_user pm2 start /home/ec2-user/legacy/app.js --name rift-brain >/dev/null
as_user pm2 start /opt/rj/dev/ecosystem.config.js >/dev/null
as_user pm2 start /opt/rj/alpha/ecosystem.config.js >/dev/null
LEGACY_PID="$(pid_of rift-brain)"
ALPHA_PID="$(pid_of rift-brain-alpha)"
[ "$(exe_of rift-brain-dev)" = /usr/bin/node ] && [ "$(exe_of rift-brain)" = /usr/bin/node ] || fail "setup: the apps are not on node 16: dev $(exe_of rift-brain-dev), legacy $(exe_of rift-brain)"
DEFAULTS="$(defaults)"
echo "setup: $(node -v) at /usr, pm2 $(as_user pm2 -v | tail -n 1); $DEFAULTS"
STEPS_ALL="preflight memory node layout pm2"

# --- PLAN --------------------------------------------------------------------------------------------------------
run "$STEPS_ALL" --env dev >/tmp/plan.log 2>&1 || show_fail /tmp/plan.log "plan run"
grep -q 'will run on node 20 (/usr/bin/node-20): not installed yet' /tmp/plan.log || show_fail /tmp/plan.log "plan names the runtime"
grep -q 'PLAN: sudo dnf install nodejs20 nodejs20-npm' /tmp/plan.log || show_fail /tmp/plan.log "plan names the install"
grep -q 'PLAN: RESTART rift-brain-dev alone .*interpreter changes from node (pm2.s own, v16.20.2) to /usr/bin/node-20. rift-brain and every other pm2 app keep running' /tmp/plan.log \
  || show_fail /tmp/plan.log "plan names the restart"
[ ! -e /usr/bin/node-20 ] || fail "plan installed node 20"
grep -q 'interpreter' /opt/rj/dev/ecosystem.config.js && fail "plan wrote the ecosystem file"
[ "$(pid_of rift-brain)" = "$LEGACY_PID" ] && [ "$(pid_of rift-brain-alpha)" = "$ALPHA_PID" ] || fail "plan restarted something"
pass "PLAN: installs nothing, writes nothing, restarts nothing; names the install and the one restart (/usr/bin/node -> /usr/bin/node-20)"

grep 'end of life' /tmp/plan.log | grep -q 'v16' && show_fail /tmp/plan.log "end-of-life warning names the system node"
prov preflight RJ_TODAY=2026-01-01 bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env dev >/tmp/eol1.log 2>&1 || show_fail /tmp/eol1.log "preflight before node 20's end of life"
grep -q 'end of life' /tmp/eol1.log && show_fail /tmp/eol1.log "an end-of-life warning before node 20's end of life (16 is the system's)"
prov preflight RJ_TODAY=2026-10-09 bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env dev >/tmp/eol2.log 2>&1 || show_fail /tmp/eol2.log "preflight after node 20's end of life"
grep -q 'WARNING: node 20 (rift-brain-dev.s runtime) is past end of life (2026-04-30)' /tmp/eol2.log || show_fail /tmp/eol2.log "no end-of-life warning for node 20"
[ "$(grep -c 'end of life' /tmp/eol2.log)" = 1 ] || show_fail /tmp/eol2.log "more than one end-of-life warning"
pass "end of life: warned for the environment's node 20 only (after 2026-04-30), never for the system's 16"

# --- APPLY dev ---------------------------------------------------------------------------------------------------
run "$STEPS_ALL" --env dev --apply >/tmp/apply1.log 2>&1 || show_fail /tmp/apply1.log "dev apply"
[ "$(/usr/bin/node-20 -v | cut -d. -f1)" = v20 ] || fail "no node 20 at /usr/bin/node-20"
rpm -q nodejs20 nodejs20-npm >/dev/null || fail "nodejs20 is not an installed package"
[ "$(defaults)" = "$DEFAULTS" ] || fail "the default node/npm/npx moved: was $DEFAULTS; now $(defaults)"
pass "dnf installed $(rpm -q nodejs20); default node, npm, npx, /etc/npmrc, /usr/lib/node_modules and the alternatives unchanged ($(node -v))"

grep -q "interpreter: '/usr/bin/node-20'" /opt/rj/dev/ecosystem.config.js || fail "the ecosystem file has no node-20 interpreter"
[ "$(exe_of rift-brain-dev)" = "$(readlink -f /usr/bin/node-20)" ] || fail "dev runs $(exe_of rift-brain-dev)"
grep -q 'PASS rift-brain-dev (pid [0-9]*) runs on /usr/bin/node-20 v20' /tmp/apply1.log || show_fail /tmp/apply1.log "apply did not prove the runtime"
[ "$(pid_of rift-brain)" = "$LEGACY_PID" ] || fail "the legacy app restarted"
[ "$(pid_of rift-brain-alpha)" = "$ALPHA_PID" ] || fail "alpha restarted"
[ "$(exe_of rift-brain)" = /usr/bin/node ] && [ "$(exe_of rift-brain-alpha)" = /usr/bin/node ] || fail "legacy or alpha left node 16"
pass "dev: ecosystem interpreter /usr/bin/node-20, its process runs $(exe_of rift-brain-dev); legacy and alpha kept their pids, on node 16"

DEV_PID="$(pid_of rift-brain-dev)"
run "$STEPS_ALL" --env dev --apply >/tmp/apply2.log 2>&1 || show_fail /tmp/apply2.log "dev re-apply"
grep -q 'node 20 is installed' /tmp/apply2.log || show_fail /tmp/apply2.log "re-run did not see node 20"
grep -q 'is running this code already' /tmp/apply2.log || show_fail /tmp/apply2.log "re-run restarted dev"
[ "$(pid_of rift-brain-dev)" = "$DEV_PID" ] && [ "$(pid_of rift-brain)" = "$LEGACY_PID" ] && [ "$(pid_of rift-brain-alpha)" = "$ALPHA_PID" ] \
  || fail "a re-run restarted an app"
run "$STEPS_ALL" --env dev >/tmp/plan2.log 2>&1 || show_fail /tmp/plan2.log "dev plan after apply"
grep -q 'PLAN: rift-brain-dev already runs on /usr/bin/node-20' /tmp/plan2.log || show_fail /tmp/plan2.log "plan after apply"
pass "dev re-run: installs nothing, restarts nothing; its plan says it already runs on node 20"

prov preflight RJ_NODE_BIN=/usr/bin/node bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env dev >/tmp/floor.log 2>&1 && show_fail /tmp/floor.log "a node 16 runtime passed the floor"
grep -q 'FAIL: /usr/bin/node is node v16.20.2; rift-brain-dev needs 20 or newer' /tmp/floor.log || show_fail /tmp/floor.log "the floor's refusal"
pass "the floor: a runtime under node 20 is refused"

# --- alpha -------------------------------------------------------------------------------------------------------
run "$STEPS_ALL" --env alpha >/tmp/plan-alpha.log 2>&1 || show_fail /tmp/plan-alpha.log "alpha plan"
grep -q 'PLAN: RESTART rift-brain-alpha alone' /tmp/plan-alpha.log || show_fail /tmp/plan-alpha.log "alpha plan names its restart"
grep -q 'PLAN: sudo dnf' /tmp/plan-alpha.log && show_fail /tmp/plan-alpha.log "alpha plans a second install"
run "$STEPS_ALL" --env alpha --apply >/tmp/apply-alpha.log 2>&1 || show_fail /tmp/apply-alpha.log "alpha apply"
[ "$(exe_of rift-brain-alpha)" = "$(readlink -f /usr/bin/node-20)" ] || fail "alpha runs $(exe_of rift-brain-alpha)"
[ "$(pid_of rift-brain)" = "$LEGACY_PID" ] && [ "$(pid_of rift-brain-dev)" = "$DEV_PID" ] || fail "alpha's apply restarted legacy or dev"
[ "$(exe_of rift-brain)" = /usr/bin/node ] || fail "the legacy app left node 16"
pass "alpha: moves to node 20 alone; legacy (node 16) and dev kept their pids"

# --- the brain step: npm ci on node 20 ---------------------------------------------------------------------------
as_user git config --global --add safe.directory '*'
BR=/home/ec2-user/rjb
prov "layout brain" RJ_ROOT="$BR" bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env alpha --apply >/tmp/brain1.log 2>&1 \
  || show_fail /tmp/brain1.log "brain step"
grep -q 'npm ci --omit=dev: npm 10\.[0-9.]* on node v20\.' /tmp/brain1.log || show_fail /tmp/brain1.log "npm ci did not run npm 10 on node 20"
[ "$(cat "$BR/alpha/brain/node_modules/.rj-node-major")" = 20 ] && [ -d "$BR/alpha/brain/node_modules/express" ] || fail "node_modules"
(cd "$BR/alpha/brain" && /usr/bin/node-20 -e "require('express'); require('mysql2'); require('./src/config/env')") || fail "the brain's modules do not load on node 20"
prov "layout brain" RJ_ROOT="$BR" bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env alpha --apply >/tmp/brain2.log 2>&1 \
  || show_fail /tmp/brain2.log "brain step re-run"
grep -q 'npm ci' /tmp/brain2.log && show_fail /tmp/brain2.log "a re-run at the same commit ran npm ci again"
echo 16 >"$BR/alpha/brain/node_modules/.rj-node-major"
prov "layout brain" RJ_ROOT="$BR" bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env alpha >/tmp/brain-plan.log 2>&1 \
  || show_fail /tmp/brain-plan.log "brain plan"
grep -q 'node_modules was installed by node 16: installs again' /tmp/brain-plan.log || show_fail /tmp/brain-plan.log "plan names the reinstall"
prov "layout brain" RJ_ROOT="$BR" bash /infra/box/provision.sh --ref "$RJ_TEST_REF" --env alpha --apply >/tmp/brain3.log 2>&1 \
  || show_fail /tmp/brain3.log "brain step after a node 16 install"
grep -q 'npm ci --omit=dev: npm 10' /tmp/brain3.log || show_fail /tmp/brain3.log "node_modules from node 16 was not reinstalled"
pass "brain: npm ci runs npm $(/usr/bin/node-20 "$(readlink -f /usr/bin/npm-20)" -v) on node 20 once per commit, and again over a node 16 install; the brain's modules load on $(/usr/bin/node-20 -v)"

[ "$(defaults)" = "$DEFAULTS" ] && [ "$(pid_of rift-brain)" = "$LEGACY_PID" ] || fail "the end state moved the defaults or the legacy app"

# The undo's last line: removing the packages (their uninstall scriptlets run) leaves the defaults as they were.
dnf -y -q remove nodejs20 nodejs20-npm >/tmp/remove.log 2>&1 || show_fail /tmp/remove.log "dnf remove"
[ ! -e /usr/bin/node-20 ] && [ "$(defaults)" = "$DEFAULTS" ] || fail "removing nodejs20 moved the defaults: $(defaults)"
pass "undo: dnf remove nodejs20 nodejs20-npm leaves node, npm, npx and the alternatives as they were"
echo "provision_node: $PASSES passed"
