#!/usr/bin/env bash
# Stands one environment up on the box (RJ 463, spec M1). Runs ON the box as ec2-user (it sudoes where it must);
# infra/provision_box.sh copies it there and runs it. Idempotent: every step checks before it acts.
#
#   bash provision.sh --env dev|alpha --ref <commit> [--apply] [--recopy-db]
#
#   (no --apply)   PLAN: read-only. Checks the box and prints what --apply would do. Changes nothing.
#   --apply        do it
#   --recopy-db    dev only: drop rift_brain_dev and copy rift_brain again (dev's data is a disposable copy)
#
# What --apply does, for <env>:
#   1. Caddy (pinned release binary, checksum-verified) + its systemd unit; /etc/caddy/sites/<env>.caddy proxies
#      <api host> -> 127.0.0.1:<public port>, and answers 503 NET_UNREACHABLE when the brain is down
#   2. /opt/rj/<env>/{brain,servers,logs}; brain is a Rift-Brain checkout at <commit>, npm ci --omit=dev
#   3. /opt/rj/<env>/brain/.env, only if absent (chmod 600, keys from openssl rand; they never leave the box)
#   4. the database rift_brain_<env> and its user (grants on that database only); dev is a dump-and-load copy
#      of rift_brain, then migrate --baseline && migrate; alpha is built fresh by migrate
#   5. pm2 app rift-brain-<env> (treekill: false), pm2 save
#   6. checks: the brain answers on 127.0.0.1, and through Caddy over HTTPS
#
# Never touched: the legacy rift-brain pm2 app, its checkout and .env, the rift_brain database (read only, by
# mysqldump), the legacy server binary, TCP 3000 and UDP 8080-8085.
#
# The MariaDB admin connection is "sudo mysql" (unix socket root), unless RJ_MYSQL_ADMIN / RJ_MYSQLDUMP_ADMIN name
# another, e.g. RJ_MYSQL_ADMIN="mysql --defaults-extra-file=$HOME/.rj-admin.cnf".
set -euo pipefail

CADDY_VERSION=2.11.7
DOMAIN=riftjumpers.space
REPO_URL=https://github.com/kgronner1/Rift-Brain.git
RJ_ROOT="${RJ_ROOT:-/opt/rj}"
LEGACY_DB=rift_brain
LEGACY_APP=rift-brain
BOX_USER="$(id -un)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
read -r -a MYSQL_ADMIN <<<"${RJ_MYSQL_ADMIN:-sudo mysql}"
read -r -a MYSQLDUMP_ADMIN <<<"${RJ_MYSQLDUMP_ADMIN:-sudo mysqldump}"
# Who the brain's database user may connect as. MYSQL_HOST=127.0.0.1 is TCP; MariaDB may see it as either.
read -r -a DB_USER_HOSTS <<<"${RJ_DB_USER_HOSTS:-localhost 127.0.0.1}"

ENV_NAME=""
REF=""
APPLY=0
RECOPY=0
# Steps a test can switch off (infra/test/provision_db.sh runs the database step alone).
STEPS="${RJ_PROVISION_STEPS:-preflight caddy layout brain dotenv database pm2 verify}"

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --recopy-db) RECOPY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "provision.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

case "$ENV_NAME" in
  dev)   API_HOST="api-dev.$DOMAIN"; PUBLIC_PORT=3001; INTERNAL_PORT=3101; GAME_PORTS=8100-8104; DB_INIT=copy ;;
  alpha) API_HOST="api.$DOMAIN";     PUBLIC_PORT=3002; INTERNAL_PORT=3102; GAME_PORTS=8090-8099; DB_INIT=fresh ;;
  *) echo "provision.sh: --env dev|alpha" >&2; exit 2 ;;
esac
[ "$RECOPY" = 0 ] || [ "$ENV_NAME" = dev ] || { echo "provision.sh: --recopy-db is for dev only" >&2; exit 2; }

ENV_DIR="$RJ_ROOT/$ENV_NAME"
BRAIN_DIR="$ENV_DIR/brain"
DOTENV="$BRAIN_DIR/.env"
DB_NAME="rift_brain_$ENV_NAME"
DB_USER="rift_brain_$ENV_NAME"
APP="rift-brain-$ENV_NAME"
ECOSYSTEM="$ENV_DIR/ecosystem.config.js"
SITE="/etc/caddy/sites/$ENV_NAME.caddy"

say() { echo "[provision $ENV_NAME] $*"; }
plan() { echo "[provision $ENV_NAME] PLAN: $*"; }
die() { echo "[provision $ENV_NAME] FAIL: $*" >&2; exit 1; }
step_on() { [[ " $STEPS " == *" $1 "* ]]; }
admin_sql() { "${MYSQL_ADMIN[@]}" --batch --skip-column-names -e "$1"; }
# The generated passwords are hex; a hand-edited one must still be safe inside a SQL string literal.
safe_password() { [[ "$1" =~ ^[A-Za-z0-9._~+-]+$ ]]; }

if [ "$APPLY" = 1 ]; then say "APPLY"; else say "PLAN only: read-only; nothing on this box changes"; fi

# --- 0. preflight ------------------------------------------------------------------------------------------------
step_preflight() {
  [ -n "$REF" ] || die "--ref <commit> is required (infra/provision_box.sh passes the commit you have checked out)"
  # shellcheck disable=SC1091
  say "os: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") $(uname -m)"
  [ "$(uname -m)" = x86_64 ] || die "Caddy is pinned for linux_amd64; this box is $(uname -m)"
  local missing=()
  for c in node npm pm2 git openssl curl tar sha512sum systemctl; do command -v "$c" >/dev/null || missing+=("$c"); done
  [ "${#missing[@]}" = 0 ] || die "missing on the box: ${missing[*]}"
  say "node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | tail -n 1)"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  # 16 is what the box has (and what the legacy brain runs on); the brain's runtime code and dependencies load on
  # 16.20.2. Node 16 is past end of life: the upgrade is RJ 477.
  [ "$major" -ge 16 ] || die "node $(node -v) is too old; the brain needs 16 or newer"
  [ "$major" -ge 18 ] || say "WARNING: node $(node -v) is past end of life (RJ 477)"
  admin_sql 'SELECT 1' >/dev/null 2>&1 || die "cannot reach MariaDB as admin with: ${MYSQL_ADMIN[*]} (set RJ_MYSQL_ADMIN)"
  say "MariaDB $(admin_sql 'SELECT VERSION()')"
  [ "$(admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$LEGACY_DB'")" = 1 ] \
    || [ "$DB_INIT" = fresh ] || die "the legacy database $LEGACY_DB is not here, so there is nothing to copy"
  say "memory: $(free -m | awk '/^Mem:/{print $2" MB total, "$7" MB available"}'); disk: $(df -h / | awk 'NR==2{print $4" free on /"}')"
  # Anything already on the ports this environment needs, that is not ours.
  local busy
  for p in 80 443 "$PUBLIC_PORT" "$INTERNAL_PORT"; do
    busy="$(sudo ss -ltnpH "sport = :$p" 2>/dev/null | grep -o 'users:(("[^"]*"' | cut -d'"' -f2 | sort -u | tr '\n' ' ' || true)"
    [ -z "$busy" ] && continue
    case "$p:$busy" in
      80:caddy*|443:caddy*) ;;
      "$PUBLIC_PORT":node*|"$INTERNAL_PORT":node*) pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP\"" \
        || die "TCP $p is held by $busy, not by $APP" ;;
      *) die "TCP $p is held by $busy; this environment needs it" ;;
    esac
  done
  if pm2 jlist 2>/dev/null | grep -q "\"name\":\"$LEGACY_APP\""; then
    say "legacy pm2 app $LEGACY_APP is in $BOX_USER's pm2 (left alone)"
  else
    say "NOTE: no $LEGACY_APP in $BOX_USER's pm2; if it runs under root (sudo pm2 list), $APP will run beside it under $BOX_USER"
  fi
  systemctl is-enabled --quiet "pm2-$BOX_USER" 2>/dev/null \
    || say "WARNING: pm2-$BOX_USER is not an enabled service, so pm2 save does not survive a reboot (pm2 startup)"
}

# --- 1. Caddy ----------------------------------------------------------------------------------------------------
install_file() { # install_file <src> <dest> <mode>: copies only when different; sets CHANGED=1 if it did
  if sudo test -f "$2" && sudo cmp -s "$1" "$2"; then return 0; fi
  CHANGED=1
  if [ "$APPLY" = 1 ]; then sudo install -m "$3" -o root -g root "$1" "$2"; say "wrote $2"; else plan "write $2"; fi
}

step_caddy() {
  local have=""
  [ -x /usr/local/bin/caddy ] && have="$(/usr/local/bin/caddy version | awk '{print $1}')"
  if [ "$have" = "v$CADDY_VERSION" ]; then
    say "caddy v$CADDY_VERSION is installed"
  elif [ "$APPLY" = 1 ]; then
    local tmp base
    tmp="$(mktemp -d)"
    base="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
    curl -fsSL -o "$tmp/caddy.tar.gz" "$base/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
    curl -fsSL -o "$tmp/checksums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
    (cd "$tmp" && grep " caddy_${CADDY_VERSION}_linux_amd64.tar.gz\$" checksums.txt \
      | sed "s/caddy_${CADDY_VERSION}_linux_amd64.tar.gz/caddy.tar.gz/" | sha512sum -c -) \
      || die "the Caddy download does not match its published checksum"
    tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
    sudo install -m 0755 -o root -g root "$tmp/caddy" /usr/local/bin/caddy
    rm -rf "$tmp"
    say "installed caddy $(/usr/local/bin/caddy version | awk '{print $1}') (was: ${have:-none})"
  else
    plan "install caddy v$CADDY_VERSION to /usr/local/bin/caddy (have: ${have:-none}), checksum-verified"
  fi

  if ! id caddy >/dev/null 2>&1; then
    if [ "$APPLY" = 1 ]; then
      sudo groupadd --system caddy 2>/dev/null || true
      sudo useradd --system --gid caddy --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
      say "created the caddy system user"
    else plan "create the caddy system user (home /var/lib/caddy)"; fi
  fi
  if [ "$APPLY" = 1 ]; then sudo install -d -m 0755 /etc/caddy /etc/caddy/sites; fi

  local site_tmp
  site_tmp="$(mktemp)"
  sed -e "s/@ENV@/$ENV_NAME/" -e "s/@HOST@/$API_HOST/" -e "s/@UPSTREAM@/127.0.0.1:$PUBLIC_PORT/" \
    "$HERE/site.caddy.tmpl" >"$site_tmp"
  CHANGED=0
  install_file "$HERE/caddy.service" /etc/systemd/system/caddy.service 0644
  local unit_changed=$CHANGED
  CHANGED=0
  install_file "$HERE/Caddyfile" /etc/caddy/Caddyfile 0644
  install_file "$site_tmp" "$SITE" 0644
  local config_changed=$CHANGED
  rm -f "$site_tmp"

  if [ "$APPLY" = 0 ]; then
    plan "systemctl enable --now caddy; reload when its config changed"
    return
  fi
  sudo -u caddy /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    || { sudo -u caddy /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; die "the Caddy config does not validate"; }
  [ "$unit_changed" = 0 ] || sudo systemctl daemon-reload
  if ! systemctl is-active --quiet caddy; then
    sudo systemctl enable --now caddy
    say "caddy started"
  elif [ "$unit_changed" = 1 ]; then
    sudo systemctl restart caddy
    say "caddy restarted (its unit changed)"
  elif [ "$config_changed" = 1 ]; then
    sudo systemctl reload caddy
    say "caddy reloaded"
  else
    say "caddy is running with this config"
  fi
  sudo systemctl is-enabled --quiet caddy || sudo systemctl enable caddy
}

# --- 2. directories and the checkout -----------------------------------------------------------------------------
step_layout() {
  local d
  for d in "$RJ_ROOT" "$ENV_DIR" "$ENV_DIR/servers" "$ENV_DIR/logs"; do
    if [ -d "$d" ]; then continue; fi
    if [ "$APPLY" = 1 ]; then sudo install -d -m 0755 -o "$BOX_USER" -g "$(id -gn)" "$d"; say "created $d"
    else plan "create $d (owner $BOX_USER)"; fi
  done
}

step_brain() {
  if [ ! -d "$BRAIN_DIR/.git" ]; then
    if [ "$APPLY" = 1 ]; then git clone --quiet "$REPO_URL" "$BRAIN_DIR"; say "cloned $REPO_URL into $BRAIN_DIR"
    else plan "git clone $REPO_URL $BRAIN_DIR"; fi
  fi
  if [ "$APPLY" = 0 ]; then
    plan "check out $REF (detached) in $BRAIN_DIR; npm ci --omit=dev"
    return
  fi
  git -C "$BRAIN_DIR" fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
  git -C "$BRAIN_DIR" cat-file -e "$REF^{commit}" 2>/dev/null || die "$REF is not on $REPO_URL (pushed?)"
  local before
  before="$(git -C "$BRAIN_DIR" rev-parse HEAD 2>/dev/null || echo none)"
  git -C "$BRAIN_DIR" checkout --quiet --detach "$REF"
  BRAIN_COMMIT="$(git -C "$BRAIN_DIR" rev-parse HEAD)"
  if [ "$before" != "$BRAIN_COMMIT" ] || [ ! -d "$BRAIN_DIR/node_modules" ]; then
    (cd "$BRAIN_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
    BRAIN_CHANGED=1
  fi
  say "brain at $(git -C "$BRAIN_DIR" log -1 --format='%h %s' HEAD)"
}

# --- 3. .env -----------------------------------------------------------------------------------------------------
dotenv_get() { sed -n "s/^$1=//p" "$DOTENV" | tail -n 1; }

step_dotenv() {
  if [ -f "$DOTENV" ]; then
    local e
    e="$(dotenv_get ENV)"
    [ "$e" = "$ENV_NAME" ] || die "$DOTENV says ENV=$e, not $ENV_NAME; fix it by hand"
    if [ -z "$(find "$DOTENV" -perm 600)" ]; then
      if [ "$APPLY" = 1 ]; then chmod 600 "$DOTENV"; say "chmod 600 $DOTENV"; else plan "chmod 600 $DOTENV"; fi
    fi
    say "$DOTENV exists; left as it is (keys unchanged)"
    return
  fi
  if [ "$APPLY" = 0 ]; then
    plan "write $DOTENV (chmod 600): ENV=$ENV_NAME, ports $PUBLIC_PORT/$INTERNAL_PORT, UDP $GAME_PORTS, database $DB_NAME, fresh keys"
    return
  fi
  local tmp
  tmp="$(umask 077 && mktemp "$BRAIN_DIR/.env.XXXXXX")"
  cat >"$tmp" <<EOF
# Written by infra/box/provision.sh (RJ 463) on $(date -u +%Y-%m-%dT%H:%M:%SZ). The keys were made here and never
# leave this box: a new environment gets new keys, and a lost .env means new keys (every session signs out).
ENV=$ENV_NAME
BIND_HOST=127.0.0.1
PUBLIC_PORT=$PUBLIC_PORT
INTERNAL_PORT=$INTERNAL_PORT
GAME_PORTS=$GAME_PORTS
GAME_HOST=play.$DOMAIN
SERVERS_DIR=$ENV_DIR/servers
# Until M4 routes per wire protocol, one binary. Nothing is deployed here yet: dev multiplayer starts with M4.
SERVER_BINARY=$ENV_DIR/servers/server.x86_64
CONFIG_URL=https://config.$DOMAIN/$ENV_NAME/client.v1.json

MYSQL_HOST=127.0.0.1
${RJ_MYSQL_PORT:+MYSQL_PORT=$RJ_MYSQL_PORT}
MYSQL_USER=$DB_USER
MYSQL_PASSWORD=$(openssl rand -hex 24)
MYSQL_DATABASE=$DB_NAME

SESSION_KEY=$(openssl rand -hex 32)
JOIN_KEY=$(openssl rand -hex 32)
LOBBY_MASTER_KEY=$(openssl rand -hex 32)
EOF
  chmod 600 "$tmp"
  mv "$tmp" "$DOTENV"
  say "wrote $DOTENV (chmod 600, new keys)"
}

# --- 4. the database ---------------------------------------------------------------------------------------------
table_count() {
  admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$1'"
}

db_exists() {
  [ "$(admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'")" = 1 ]
}

baselined() {
  [ "$(admin_sql "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='schema_migrations'")" = 1 ] \
    && [ "$(admin_sql "SELECT COUNT(*) FROM \`$DB_NAME\`.schema_migrations WHERE version=1")" = 1 ]
}

step_database() {
  [ "$DB_NAME" != "$LEGACY_DB" ] || die "refusing to provision $LEGACY_DB"
  local tables=0
  db_exists && tables="$(table_count "$DB_NAME")"
  say "$DB_NAME: $(db_exists && echo "exists, $tables tables" || echo absent)"

  if [ "$RECOPY" = 1 ] && db_exists; then
    if [ "$APPLY" = 1 ]; then admin_sql "DROP DATABASE \`$DB_NAME\`"; say "dropped $DB_NAME (--recopy-db)"; tables=0
    else plan "DROP DATABASE $DB_NAME (--recopy-db), then copy $LEGACY_DB again"; tables=0; fi
  fi

  if [ "$APPLY" = 1 ]; then
    admin_sql "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  elif ! db_exists; then
    plan "CREATE DATABASE $DB_NAME"
  fi

  # The user: grants on this database and nothing else. Its password is the one in .env, so a re-run (or a
  # hand-edited .env) brings the two back in step.
  local pw="" h
  [ -f "$DOTENV" ] && pw="$(dotenv_get MYSQL_PASSWORD)"
  for h in "${DB_USER_HOSTS[@]}"; do
    if [ "$APPLY" = 1 ]; then
      [ -n "$pw" ] || die "no MYSQL_PASSWORD in $DOTENV"
      safe_password "$pw" || die "MYSQL_PASSWORD in $DOTENV has characters this script will not put in SQL ([A-Za-z0-9._~+-] only)"
      admin_sql "CREATE USER IF NOT EXISTS '$DB_USER'@'$h' IDENTIFIED BY '$pw';
                 ALTER USER '$DB_USER'@'$h' IDENTIFIED BY '$pw';
                 GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'$h';"
    else
      plan "user '$DB_USER'@'$h' with ALL PRIVILEGES on $DB_NAME.* only, password from .env"
    fi
  done
  if [ "$APPLY" = 1 ]; then
    local other
    other="$(admin_sql "SELECT DISTINCT TABLE_SCHEMA FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES
                        WHERE GRANTEE LIKE '''$DB_USER''@%' AND TABLE_SCHEMA <> '$DB_NAME'")"
    [ -z "$other" ] || die "'$DB_USER' also has grants on: $other (remove them by hand)"
    say "user $DB_USER: grants on $DB_NAME only"
  fi

  local copied=0
  if [ "$DB_INIT" = copy ] && [ "$tables" = 0 ]; then
    if [ "$APPLY" = 1 ]; then
      say "copying $LEGACY_DB into $DB_NAME (mysqldump --single-transaction; $LEGACY_DB is only read)"
      # Dumped whole before any of it loads, and a failed load drops the half-made copy: a re-run must never
      # mistake a partial copy for a finished one.
      local dump
      dump="$(umask 077 && mktemp "${TMPDIR:-/tmp}/rj-$DB_NAME-dump.XXXXXX")"
      "${MYSQLDUMP_ADMIN[@]}" --single-transaction --routines --triggers --events --hex-blob "$LEGACY_DB" >"$dump" \
        || { rm -f "$dump"; die "mysqldump $LEGACY_DB failed; nothing was loaded"; }
      if ! "${MYSQL_ADMIN[@]}" "$DB_NAME" <"$dump"; then
        rm -f "$dump"
        admin_sql "DROP DATABASE \`$DB_NAME\`"
        die "loading the copy failed; dropped the partial $DB_NAME (re-run to try again)"
      fi
      rm -f "$dump"
      copied=1
      say "copied: $(table_count "$DB_NAME") tables; users: $(admin_sql "SELECT COUNT(*) FROM \`$DB_NAME\`.users" 2>/dev/null || echo '?')"
    else
      plan "mysqldump $LEGACY_DB | mysql $DB_NAME ($LEGACY_DB is only read)"
    fi
  elif [ "$DB_INIT" = copy ]; then
    say "$DB_NAME already holds a copy; not copied again (--recopy-db to start over)"
  fi

  # Migrations run as the brain, with its .env.
  if [ "$APPLY" = 0 ]; then
    if [ "$DB_INIT" = copy ]; then plan "cd $BRAIN_DIR && npm run migrate -- --baseline (once) && npm run migrate"
    else plan "cd $BRAIN_DIR && npm run migrate (builds $DB_NAME from 0001)"; fi
    if db_exists && [ -d "$BRAIN_DIR/node_modules" ] && [ -f "$DOTENV" ]; then
      say "migrate --status now:"
      (cd "$BRAIN_DIR" && node src/migrate.js --status) | sed 's/^/    /' || true
    fi
    return
  fi
  if [ "$DB_INIT" = copy ] && ! baselined; then
    (cd "$BRAIN_DIR" && node src/migrate.js --baseline)
  fi
  (cd "$BRAIN_DIR" && node src/migrate.js)
  [ "$copied" = 0 ] || say "the copy is baselined and migrated"
}

# --- 5. pm2 ------------------------------------------------------------------------------------------------------
step_pm2() {
  local eco_tmp
  eco_tmp="$(mktemp)"
  cat >"$eco_tmp" <<EOF
// Written by infra/box/provision.sh (RJ 463); a re-run overwrites it.
// treekill: false -- restarting the brain must never take its game servers with it (spec 5).
module.exports = {
  apps: [{
    name: '$APP',
    cwd: '$BRAIN_DIR',
    script: 'src/app.js',
    treekill: false,
    autorestart: true,
    max_restarts: 20,
    restart_delay: 2000,
    kill_timeout: 5000,
    out_file: '$ENV_DIR/logs/brain.out.log',
    error_file: '$ENV_DIR/logs/brain.err.log',
    time: true,
    env: { NODE_ENV: 'production' },
  }],
};
EOF
  local eco_changed=0
  cmp -s "$eco_tmp" "$ECOSYSTEM" 2>/dev/null || eco_changed=1
  if [ "$APPLY" = 0 ]; then
    [ "$eco_changed" = 0 ] || plan "write $ECOSYSTEM"
    if pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP\""; then plan "restart pm2 app $APP if its code or config changed"
    else plan "pm2 start $ECOSYSTEM --only $APP; pm2 save"; fi
    rm -f "$eco_tmp"
    return
  fi
  [ "$eco_changed" = 0 ] || { mv "$eco_tmp" "$ECOSYSTEM"; say "wrote $ECOSYSTEM"; }
  rm -f "$eco_tmp"
  if ! pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP\""; then
    pm2 start "$ECOSYSTEM" --only "$APP"
  elif [ "$eco_changed" = 1 ]; then
    # A changed ecosystem file (treekill, paths) only takes effect on a fresh start of that one app.
    pm2 delete "$APP" >/dev/null
    pm2 start "$ECOSYSTEM" --only "$APP"
  elif [ "${BRAIN_CHANGED:-0}" = 1 ]; then
    pm2 restart "$APP" --update-env
  else
    say "pm2 app $APP is running this code already"
  fi
  pm2 save >/dev/null
  say "pm2 saved (the process list survives a reboot; $LEGACY_APP is in it as before)"
}

# --- 6. checks ---------------------------------------------------------------------------------------------------
step_verify() {
  if [ "$APPLY" = 0 ]; then
    plan "check http://127.0.0.1:$PUBLIC_PORT/ and https://$API_HOST/"
    return
  fi
  local ok=0
  for _ in $(seq 1 20); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PUBLIC_PORT/" && { ok=1; break; }
    sleep 1
  done
  [ "$ok" = 1 ] || { pm2 logs "$APP" --lines 30 --nostream || true; die "the brain does not answer on 127.0.0.1:$PUBLIC_PORT"; }
  say "PASS the brain answers on 127.0.0.1:$PUBLIC_PORT"
  if curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$PUBLIC_PORT/user_stats_columns"; then
    say "PASS it reads $DB_NAME"
  else
    say "WARNING: POST /user_stats_columns failed; check pm2 logs $APP"
  fi
  ok=0
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "https://$API_HOST/" && { ok=1; break; }
    sleep 2
  done
  if [ "$ok" = 1 ]; then say "PASS https://$API_HOST/ answers (Caddy has its certificate)"
  else say "WARNING: https://$API_HOST/ does not answer yet. DNS (rj-box) must point here and TCP 80/443 be open; see journalctl -u caddy"; fi
}

for s in preflight caddy layout brain dotenv database pm2 verify; do
  step_on "$s" || continue
  "step_$s"
done
say "done ($([ "$APPLY" = 1 ] && echo applied || echo plan only))"
