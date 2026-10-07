#!/usr/bin/env bash
# Checks infra/box's Caddy config in the official Caddy image (Docker): it validates, and with the brain down a
# request gets the 503 NET_UNREACHABLE envelope (spec 4.2), as parseable JSON with retry: backoff.
#
#   bash infra/test/caddy_envelope.sh
#
# Needs Docker. Starts one container (rj-caddy-test-<pid>) and removes it on every exit path.
set -euo pipefail

BOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../box" && pwd)"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2.11}"
NAME="rj-caddy-test-$$"
PORT="${CADDY_TEST_PORT:-18080}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rj-caddy-test.XXXXXX")"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/sites"
cp "$BOX_DIR/Caddyfile" "$WORK/Caddyfile"
# The real site with a plain-HTTP address (no certificate in a test) and an upstream nothing listens on.
sed -e 's/@ENV@/test/' -e 's/@HOST@/:8080/' -e 's/@UPSTREAM@/127.0.0.1:59999/' \
  "$BOX_DIR/site.caddy.tmpl" >"$WORK/sites/test.caddy"
# The real site as provision.sh renders it, too, so its hostname form validates.
sed -e 's/@ENV@/dev/' -e 's/@HOST@/api-dev.riftjumpers.space/' -e 's/@UPSTREAM@/127.0.0.1:3001/' \
  "$BOX_DIR/site.caddy.tmpl" >"$WORK/dev.caddy"

docker run --rm -v "$WORK:/etc/caddy:ro" "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>"$WORK/validate.log" \
  || { cat "$WORK/validate.log" >&2; echo "FAIL caddy validate (test site)"; exit 1; }
echo "PASS caddy validate: Caddyfile + the test site"

docker run --rm -v "$WORK:/etc/caddy:ro" "$CADDY_IMAGE" \
  caddy adapt --config /etc/caddy/dev.caddy --adapter caddyfile >/dev/null 2>"$WORK/adapt.log" \
  || { cat "$WORK/adapt.log" >&2; echo "FAIL caddy adapt (dev site)"; exit 1; }
echo "PASS caddy adapt: the dev site as provision.sh writes it"

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$WORK:/etc/caddy:ro" "$CADDY_IMAGE" \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.2
done

STATUS="$(curl -s -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' "http://127.0.0.1:$PORT/v1/session")"
[ "$STATUS" = 503 ] || { echo "FAIL expected 503 with the upstream down, got $STATUS"; cat "$WORK/body"; exit 1; }
echo "PASS 503 with the upstream down"
grep -qi '^content-type: application/json' "$WORK/headers" || { echo "FAIL Content-Type"; cat "$WORK/headers"; exit 1; }
echo "PASS Content-Type: application/json"

# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const headers = fs.readFileSync(process.argv[2], "utf8");
const e = body.error;
const fail = (m) => { console.log(`FAIL ${m}: ${JSON.stringify(body)}`); process.exit(1); };
if (body.result !== "error") fail("result is not error");
if (e.code !== "NET_UNREACHABLE") fail("code");
if (e.retry.kind !== "backoff") fail("retry.kind");
if (e.scope !== "request") fail("scope");
if (e.action.kind !== "dismiss") fail("action.kind");
if (!/^Can.t reach the Rift Jumpers servers/.test(e.message) || e.message.length > 280) fail("message");
if (!/^[0-9a-f-]{36}$/.test(e.ref)) fail("ref is not a request uuid");
const h = headers.match(/^x-rj-ref:\s*(\S+)/mi);
if (!h || h[1] !== e.ref) fail("X-RJ-Ref header does not match ref");
if (/^retry-after:/mi.test(headers)) fail("a Retry-After header would turn backoff into after");
console.log(`PASS envelope: ${JSON.stringify(body)}`);
' "$WORK/body" "$WORK/headers"
