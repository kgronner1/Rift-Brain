'use strict';
// Builds fixtures/join_token_v1.txt: join tokens (spec 4.8) signed with a fixed key at a fixed time, for the
// client's cross-language contract test (Wobble Planet Tools/harness/test_net_tokens.gd verifies a copy of it).
// Deterministic: the same text every run. test/tokens.test.js fails if the checked-in file drifts from it.
//
//   node fixtures/build_join_token_v1.js           print it
//   node fixtures/build_join_token_v1.js --write   write fixtures/join_token_v1.txt

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { signJoin, signSession } = require('../src/auth/tokens');

const FILE = path.join(__dirname, 'join_token_v1.txt');
// A fixture key, public on purpose: sha256("rift-jumpers token fixture v1"). Never a real environment's key.
const KEY_HEX = crypto.createHash('sha256').update('rift-jumpers token fixture v1').digest('hex');
const WRONG_KEY_HEX = crypto.createHash('sha256').update('rift-jumpers token fixture v1, the wrong key').digest('hex');
const IAT = 1790000000;
const NOW = IAT + 10;

const CLAIMS = {
  uid: 4242, uname: 'Pilot_One', lobby: 'lobby-dev-8100-7c2a', wire: 1, fp: '9f2c4e1a0b7d3c55', env: 'dev',
  seat: 's-3f9a1c2e7b5d4f60', host: true, jti: 'j-0123456789abcdef',
};

function build() {
  const join = signJoin({ ...CLAIMS, nowSec: IAT, keyHex: KEY_HEX });
  const utf8 = signJoin({ ...CLAIMS, uname: 'Zoë ★', jti: 'j-fedcba9876543210', nowSec: IAT, keyHex: KEY_HEX });
  const sig = join.token.split('.')[1];
  const tamperedPayload = Buffer.from(JSON.stringify({ ...join.payload, uid: 4243 }), 'utf8').toString('base64url');
  const wrongKey = signJoin({ ...CLAIMS, nowSec: IAT, keyHex: WRONG_KEY_HEX }).token;
  const session = signSession({ uid: 4242, env: 'dev', nowSec: IAT, keyHex: KEY_HEX }).token;
  const otherEnv = signJoin({ ...CLAIMS, env: 'alpha', nowSec: IAT, keyHex: KEY_HEX }).token;
  const lines = [
    '# Rift-Brain fixtures/join_token_v1.txt (RJ 465). Built by fixtures/build_join_token_v1.js; do not edit by hand.',
    '# Join tokens of spec 4.8, signed with a fixed, public fixture key at a fixed time.',
    '#',
    '# Format: one name=value per line; lines starting with # are comments; the value runs to the end of the line.',
    '# The token: base64url(payload_json) "." base64url(HMAC-SHA256(key, payload_part)), where',
    '#   - base64url is RFC 4648 section 5 with no "=" padding;',
    '#   - the HMAC key is the 32 bytes key_hex spells (decode the hex; it is not the 64 ASCII characters);',
    '#   - the HMAC message is the payload part as it appears in the token (its ASCII bytes);',
    '#   - iat and exp are whole seconds since the Unix epoch, and a token is expired once now >= exp.',
    '# A verifier checks, in order: two parts of base64url, the signature (constant time), typ, v, env, exp.',
    '#',
    '# Expected results, verifying at `now` with key_hex, typ "j" and env "dev":',
    '#   token          -> ok, and its payload equals payload_json (same keys and values)',
    '#   token_utf8     -> ok, and its uname is uname_utf8 (UTF-8 in the payload)',
    '#   token at expired_now      -> expired',
    '#   token_tampered -> signature (the payload changed, the signature did not)',
    '#   token_wrong_key -> signature',
    '#   token_session  -> typ (a session token, typ "s", signed with this key)',
    '#   token_other_env -> env',
    'format=1',
    `key_hex=${KEY_HEX}`,
    `now=${NOW}`,
    `expired_now=${join.payload.exp}`,
    `token=${join.token}`,
    `payload_json=${JSON.stringify(join.payload)}`,
    `token_utf8=${utf8.token}`,
    `uname_utf8=${utf8.payload.uname}`,
    `token_tampered=${tamperedPayload}.${sig}`,
    `token_wrong_key=${wrongKey}`,
    `token_session=${session}`,
    `token_other_env=${otherEnv}`,
    '',
  ];
  return lines.join('\n');
}

function parse(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

if (require.main === module) {
  const text = build();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(FILE, text);
    console.log(`wrote ${FILE}`);
  } else {
    process.stdout.write(text);
  }
}

module.exports = { build, parse, FILE, KEY_HEX, NOW, IAT };
