'use strict';
// RJ 458: ops/join/publish.sh against stand-ins for the AWS CLI and curl (no AWS, no network): the dry run writes
// nothing; a publish uploads every file with build.mjs's content type (application/json for both .well-known files),
// the fonts first and index.html last, invalidates /*, and checks what CloudFront serves back; a wrong type served
// back, or a stack without the join outputs, stops it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'ops', 'join', 'publish.sh');

const AWS_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/aws.log"
case " $* " in
  *" describe-stacks "*)
    [ -z "\${STUB_NO_STACK:-}" ] || { echo "An error occurred (ValidationError): Stack with id rj-edge does not exist" >&2; exit 254; }
    printf 'JoinBucketName\\trj-join-1234\\nJoinDistributionId\\tE2JOIN\\n' ;;
  *" put-object "*)
    key=""; body=""; type=""
    while [ $# -gt 0 ]; do
      case "$1" in --key) key="$2"; shift ;; --body) body="$2"; shift ;; --content-type) type="$2"; shift ;; esac
      shift
    done
    mkdir -p "$STUB_DIR/bucket/$(dirname "$key")" "$STUB_DIR/meta/$(dirname "$key")"
    cp "$body" "$STUB_DIR/bucket/$key"
    if [ "$key" = "\${STUB_BREAK_TYPE:-}" ]; then type=binary/octet-stream; fi
    printf '%s' "$type" > "$STUB_DIR/meta/$key"
    echo v1 ;;
  *" create-invalidation "*) echo I2JOIN ;;
  *" wait invalidation-completed "*) exit 0 ;;
  *) echo "stub aws: unexpected $*" >&2; exit 2 ;;
esac
`;

// CloudFront as the stack builds it: index.html for every path but /.well-known/, /assets/ and /robots.txt.
const CURL_STUB = `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; -w|--max-time) shift ;; -*) ;; *) url="$1" ;; esac
  shift
done
printf '%s\\n' "$url" >> "$STUB_DIR/curl.log"
p="/\${url#https://*/}"
case "$p" in /.well-known/*|/assets/*|/robots.txt) key="\${p#/}" ;; *) key=index.html ;; esac
[ -f "$STUB_DIR/bucket/$key" ] || exit 22
cp "$STUB_DIR/bucket/$key" "$out"
cat "$STUB_DIR/meta/$key"
`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-join-publish-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), AWS_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  const run = (args, env = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, RJ_AWS_PROFILE: 'stub', RJ_JOIN_FETCH_WAIT: '0', ...env },
    });
    return { ...r, out: r.stdout + r.stderr };
  };
  const awsLog = () => (fs.existsSync(path.join(dir, 'aws.log')) ? fs.readFileSync(path.join(dir, 'aws.log'), 'utf8').trim().split('\n') : []);
  const meta = (key) => fs.readFileSync(path.join(dir, 'meta', key), 'utf8');
  return { dir, run, awsLog, meta };
}

test('--dry-run: builds, names each file\'s type and the commands, writes nothing; goes on without the stack', async (t) => {
  const s = setup(t);
  const r = s.run(['--dry-run'], { STUB_NO_STACK: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARNING: no join outputs on stack rj-edge yet/);
  assert.match(r.out, /put-object --bucket <JoinBucketName> --key \.well-known\/assetlinks\.json .* --content-type 'application\/json'/);
  assert.match(r.out, /put-object --bucket <JoinBucketName> --key \.well-known\/apple-app-site-association .* --content-type 'application\/json'/);
  assert.match(r.out, /--key index\.html .* --content-type 'text\/html; charset=utf-8'/);
  assert.match(r.out, /--key assets\/akira-expanded\.otf .* --content-type 'font\/otf'/);
  assert.match(r.out, /not known yet, left out: ios\.team_id/);
  assert.match(r.out, /create-invalidation --distribution-id <JoinDistributionId> --paths '\/\*'/);
  assert.deepEqual(s.awsLog().map((l) => l.match(/(cloudformation|s3api|cloudfront) (\S+)/).slice(1).join(' ')), ['cloudformation describe-stacks'], 'only the read');
  assert.equal(fs.existsSync(path.join(s.dir, 'bucket')), false);

  const named = s.run(['--dry-run']);
  assert.equal(named.status, 0, named.out);
  assert.match(named.out, /s3:\/\/rj-join-1234 behind CloudFront E2JOIN/);
});

test('a publish: every file with its type, fonts first and index.html last, /* invalidated, the served copies checked', async (t) => {
  const s = setup(t);
  const keep = path.join(s.dir, 'kept');
  const r = s.run(['--keep', keep]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /published https:\/\/join\.riftjumpers\.space\//);
  const puts = s.awsLog().filter((l) => l.includes(' put-object ')).map((l) => l.match(/--key (\S+)/)[1]);
  assert.deepEqual(puts, [
    'assets/akira-expanded.otf', 'assets/michroma-regular.ttf', '.well-known/assetlinks.json',
    '.well-known/apple-app-site-association', 'robots.txt', 'index.html',
  ]);
  assert.equal(s.meta('.well-known/assetlinks.json'), 'application/json');
  assert.equal(s.meta('.well-known/apple-app-site-association'), 'application/json');
  assert.equal(s.meta('index.html'), 'text/html; charset=utf-8');
  assert.equal(s.meta('assets/michroma-regular.ttf'), 'font/ttf');
  assert.ok(s.awsLog().some((l) => / create-invalidation --distribution-id E2JOIN --paths \/\*/.test(l)));
  for (const key of puts) {
    assert.ok(fs.readFileSync(path.join(s.dir, 'bucket', key)).equals(fs.readFileSync(path.join(keep, key))), key);
  }
  const links = JSON.parse(fs.readFileSync(path.join(s.dir, 'bucket', '.well-known', 'assetlinks.json'), 'utf8'));
  assert.deepEqual(links.map((l) => l.target.package_name), ['com.riftjumpers.game', 'com.riftjumpers.game.dev']);
  const fetched = fs.readFileSync(path.join(s.dir, 'curl.log'), 'utf8');
  assert.match(fetched, /https:\/\/join\.riftjumpers\.space\/\.well-known\/apple-app-site-association/);
  assert.match(fetched, /https:\/\/join\.riftjumpers\.space\/dev\/publishchk/);
});

test('a publish stops on a stack without the join outputs, and on a .well-known file served with the wrong type', async (t) => {
  const s = setup(t);
  const none = s.run([], { STUB_NO_STACK: '1' });
  assert.equal(none.status, 1);
  assert.match(none.out, /has no JoinBucketName\/JoinDistributionId outputs: deploy it first/);
  assert.equal(s.awsLog().filter((l) => l.includes(' put-object ')).length, 0);

  const wrong = s.run([], { STUB_BREAK_TYPE: '.well-known/apple-app-site-association' });
  assert.equal(wrong.status, 1, wrong.out);
  assert.match(wrong.out, /apple-app-site-association does not serve what was uploaded \(type binary\/octet-stream, want application\/json\)/);
});
