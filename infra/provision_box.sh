#!/usr/bin/env bash
# Stands an environment up on the box, from the Mac (RJ 463, spec M1). Copies infra/box/ to the box and runs
# infra/box/provision.sh there over SSH; see that file for every step.
#
#   bash infra/provision_box.sh --env dev              PLAN: read-only on the box; prints what --apply would do
#   bash infra/provision_box.sh --env dev --apply      do it (idempotent: a re-run changes only what differs)
#   bash infra/provision_box.sh --env dev --print      print the commands and change nothing anywhere (no SSH)
#
#   --ref <commit>   the Rift-Brain commit the box runs (default: this checkout's HEAD). It must be pushed.
#   --recopy-db      dev only: drop rift_brain_dev and copy rift_brain again
#
# Reads ~/.config/rift-jumpers/deploy.env: RJ_DEPLOY_PEM, RJ_DEPLOY_HOST (user@host).
# Run after infra/deploy_stacks.sh --apply: Caddy can only get api-dev's certificate once DNS points at the box.
# Undo (spec 7a): infra/README.md, "Undo".
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"
DEPLOY_ENV="${RJ_DEPLOY_ENV_FILE:-$HOME/.config/rift-jumpers/deploy.env}"

ENV_NAME=""
REF=""
MODE=plan
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --apply) MODE=apply; PASS+=(--apply); shift ;;
    --print) MODE=print; shift ;;
    --recopy-db) PASS+=(--recopy-db); shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "provision_box.sh: unknown argument $1 (--help)" >&2; exit 2 ;;
  esac
done
case "$ENV_NAME" in dev|alpha) ;; *) echo "provision_box.sh: --env dev|alpha" >&2; exit 2 ;; esac

die() { echo "provision_box.sh: $*" >&2; exit 1; }

[ -f "$DEPLOY_ENV" ] || die "no $DEPLOY_ENV (RJ_DEPLOY_PEM, RJ_DEPLOY_HOST)"
# shellcheck source=/dev/null
. "$DEPLOY_ENV"
[ -n "${RJ_DEPLOY_PEM:-}" ] && [ -n "${RJ_DEPLOY_HOST:-}" ] || die "$DEPLOY_ENV must set RJ_DEPLOY_PEM and RJ_DEPLOY_HOST"
[ -f "$RJ_DEPLOY_PEM" ] || die "no PEM at $RJ_DEPLOY_PEM"

REF="${REF:-$(git -C "$REPO_DIR" rev-parse HEAD)}"
REF="$(git -C "$REPO_DIR" rev-parse --verify "$REF^{commit}")" || die "$REF is not a commit here"
if [ "$MODE" != print ]; then
  git -C "$REPO_DIR" fetch --quiet origin
  [ -n "$(git -C "$REPO_DIR" branch -r --contains "$REF" 2>/dev/null)" ] \
    || die "$REF is not on origin; push it first (the box clones from GitHub)"
fi
if ! git -C "$REPO_DIR" diff --quiet HEAD -- infra/box; then
  echo "WARNING: infra/box has uncommitted changes; the box gets the working tree's copy of the provisioning script"
fi

SSH=(ssh -i "$RJ_DEPLOY_PEM" -o ConnectTimeout=15)
# shellcheck disable=SC2088 # expanded by the box's shell, not this one
REMOTE_DIR='~/rj-provision'
REMOTE_RUN="bash $REMOTE_DIR/provision.sh --env $ENV_NAME --ref $REF ${PASS[*]:-}"

if [ "$MODE" = print ]; then
  echo "Would run:"
  printf '  COPYFILE_DISABLE=1 tar -C %q -cf - . | %s %q %q\n' "$INFRA_DIR/box" "$(printf '%q ' "${SSH[@]}")" \
    "$RJ_DEPLOY_HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xf -"
  printf '  %s-t %q %q\n' "$(printf '%q ' "${SSH[@]}")" "$RJ_DEPLOY_HOST" "$REMOTE_RUN"
  exit 0
fi

echo "[provision_box] $ENV_NAME on $RJ_DEPLOY_HOST at $(git -C "$REPO_DIR" log -1 --format='%h %s' "$REF") ($MODE)"
COPYFILE_DISABLE=1 tar -C "$INFRA_DIR/box" -cf - . | "${SSH[@]}" "$RJ_DEPLOY_HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR && tar -C $REMOTE_DIR -xf -"
"${SSH[@]}" -t "$RJ_DEPLOY_HOST" "$REMOTE_RUN"
