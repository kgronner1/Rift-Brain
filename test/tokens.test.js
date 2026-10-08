'use strict';
// Tokens (spec 4.8): sign/verify, typ confusion, expiry, wrong key, wrong env, the refresh grace, the lobby key,
// and fixtures/join_token_v1.txt, the client's cross-language contract test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const tokens = require('../src/auth/tokens');
const fixture = require('../fixtures/build_join_token_v1');

const KEY = '11'.repeat(32);
const OTHER = '22'.repeat(32);
const NOW = 1790000000;

test('a token is base64url(payload) "." base64url(HMAC-SHA256(32 key bytes, payload part)), unpadded', () => {
  const t = tokens.sign({ v: 1, typ: 's', uid: 1, env: 'dev', iat: NOW, exp: NOW + 60 }, KEY);
  const [part, sig] = t.split('.');
  assert.match(part, /^[A-Za-z0-9_-]+$/);
  assert.match(sig, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto.createHmac('sha256', Buffer.from(KEY, 'hex')).update(part).digest('base64url');
  assert.equal(sig, expected);
  assert.deepEqual(JSON.parse(Buffer.from(part, 'base64url').toString()), { v: 1, typ: 's', uid: 1, env: 'dev', iat: NOW, exp: NOW + 60 });
});

test('a session verifies with its key, type and env until exp', () => {
  const s = tokens.signSession({ uid: 9, env: 'dev', nowSec: NOW, keyHex: KEY });
  assert.equal(s.expires_in, 3600);
  assert.deepEqual(s.payload, { v: 1, typ: 's', uid: 9, env: 'dev', iat: NOW, exp: NOW + 3600 });
  const at = (nowSec, o = {}) => tokens.verifySession(s.token, { keyHex: KEY, env: 'dev', nowSec, ...o });
  assert.equal(at(NOW).ok, true);
  assert.equal(at(NOW + 3599).ok, true);
  assert.deepEqual([at(NOW + 3600).ok, at(NOW + 3600).reason], [false, 'expired']);
  assert.equal(at(NOW + 3600).payload.uid, 9, 'an expired token is genuine: its payload comes back');
  assert.equal(at(NOW, { keyHex: OTHER }).reason, 'signature');
  assert.equal(at(NOW, { env: 'alpha' }).reason, 'env');
  assert.equal(at(NOW, { keyHex: OTHER }).payload, undefined, 'nothing unsigned is handed back');
});

test('typ is checked first among the claims: no token type passes as another', () => {
  const grant = tokens.sign({ v: 1, typ: 'g', ticket: 'q', install: 'i', env: 'dev', iat: NOW, exp: NOW + 120 }, KEY);
  const join = tokens.signJoin({ uid: 1, uname: 'a', lobby: 'l', wire: 1, fp: 'f', env: 'dev', seat: 's', host: false, jti: 'j', nowSec: NOW, keyHex: KEY }).token;
  const session = tokens.signSession({ uid: 1, env: 'dev', nowSec: NOW, keyHex: KEY }).token;
  assert.equal(tokens.verifySession(grant, { keyHex: KEY, env: 'dev', nowSec: NOW }).reason, 'typ');
  assert.equal(tokens.verifySession(join, { keyHex: KEY, env: 'dev', nowSec: NOW }).reason, 'typ');
  assert.equal(tokens.verify(session, { keyHex: KEY, typ: 'j', env: 'dev', nowSec: NOW }).reason, 'typ');
  // typ before env and before exp: a stale session in another env is still refused for its type first.
  assert.equal(tokens.verify(session, { keyHex: KEY, typ: 'g', env: 'alpha', nowSec: NOW + 99999 }).reason, 'typ');
  const v2 = tokens.sign({ v: 2, typ: 's', uid: 1, env: 'dev', iat: NOW, exp: NOW + 60 }, KEY);
  assert.equal(tokens.verifySession(v2, { keyHex: KEY, env: 'dev', nowSec: NOW }).reason, 'version');
});

test('malformed, tampered and re-spelled tokens are refused', () => {
  const s = tokens.signSession({ uid: 1, env: 'dev', nowSec: NOW, keyHex: KEY }).token;
  const v = (t) => tokens.verifySession(t, { keyHex: KEY, env: 'dev', nowSec: NOW }).reason;
  for (const bad of ['', 'abc', 'a.b.c', `${s}.x`, `${s.split('.')[0]}.`, `=${s}`, 42, null, 'x'.repeat(5000)]) {
    assert.equal(v(bad), 'malformed', String(bad).slice(0, 20));
  }
  const [part, sig] = s.split('.');
  const tampered = Buffer.from(JSON.stringify({ v: 1, typ: 's', uid: 2, env: 'dev', iat: NOW, exp: NOW + 3600 })).toString('base64url');
  assert.equal(v(`${tampered}.${sig}`), 'signature');
  // The last base64url character of a 32-byte value carries 4 unused bits: another spelling of the same bytes.
  const last = sig[sig.length - 1];
  const respelled = sig.slice(0, -1) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(last) ^ 1)];
  assert.deepEqual(Buffer.from(respelled, 'base64url'), Buffer.from(sig, 'base64url'));
  assert.equal(v(`${part}.${respelled}`), 'signature');
  const notJson = Buffer.from('not json').toString('base64url');
  assert.equal(v(`${notJson}.${crypto.createHmac('sha256', Buffer.from(KEY, 'hex')).update(notJson).digest('base64url')}`), 'malformed');
});

test('a key must be 32 bytes of hex', () => {
  assert.throws(() => tokens.sign({}, 'short'), /64 hex/);
  assert.throws(() => tokens.verify('a.b', { keyHex: 'zz'.repeat(32), typ: 's', nowSec: NOW }), /64 hex/);
});

test('refresh: a genuine session of the same user younger than the grace, even expired', () => {
  const old = tokens.signSession({ uid: 5, env: 'dev', nowSec: NOW, keyHex: KEY }).token;
  const r = (o) => tokens.isSessionRefresh(old, { keyHex: KEY, env: 'dev', uid: 5, graceSec: 86400, nowSec: NOW, ...o });
  assert.equal(r({ nowSec: NOW + 7200 }), true, 'expired an hour ago, still a refresh');
  assert.equal(r({ nowSec: NOW + 86399 }), true);
  assert.equal(r({ nowSec: NOW + 86400 }), false, 'past the grace');
  assert.equal(r({ uid: 6 }), false, 'another user\'s session');
  assert.equal(r({ keyHex: OTHER }), false, 'forged');
  assert.equal(r({ env: 'alpha' }), false);
  assert.equal(r({ graceSec: 0 }), false);
  assert.equal(tokens.isSessionRefresh(undefined, { keyHex: KEY, env: 'dev', uid: 5, graceSec: 10, nowSec: NOW }), false);
  const grant = tokens.sign({ v: 1, typ: 'g', ticket: 'q', install: 'i', env: 'dev', iat: NOW, exp: NOW + 1 }, KEY);
  assert.equal(tokens.isSessionRefresh(grant, { keyHex: KEY, env: 'dev', graceSec: 86400, nowSec: NOW }), false);
});

test('the lobby key is hex HMAC(LOBBY_MASTER_KEY, lobby_id)', () => {
  const k = tokens.deriveLobbyKey(KEY, 'lobby-1');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, crypto.createHmac('sha256', Buffer.from(KEY, 'hex')).update('lobby-1').digest('hex'));
  assert.notEqual(k, tokens.deriveLobbyKey(KEY, 'lobby-2'));
  assert.notEqual(k, tokens.deriveLobbyKey(OTHER, 'lobby-1'));
});

test('fixtures/join_token_v1.txt is what its builder writes (fixed key, fixed now)', () => {
  assert.equal(fs.readFileSync(fixture.FILE, 'utf8'), fixture.build(),
    'stale fixture: node fixtures/build_join_token_v1.js --write, and copy it to Wobble Planet Tools/harness/fixtures/');
});

test('the fixture says what it means: every case verifies as its comment promises', () => {
  const f = fixture.parse(fs.readFileSync(fixture.FILE, 'utf8'));
  assert.equal(f.format, '1');
  const now = Number(f.now);
  const v = (t, nowSec = now) => tokens.verify(t, { keyHex: f.key_hex, typ: 'j', env: 'dev', nowSec });
  const good = v(f.token);
  assert.equal(good.ok, true);
  assert.deepEqual(good.payload, JSON.parse(f.payload_json));
  assert.deepEqual(Object.keys(good.payload), ['v', 'typ', 'uid', 'uname', 'lobby', 'wire', 'fp', 'env', 'seat', 'host', 'iat', 'exp', 'jti']);
  assert.equal(good.payload.exp - good.payload.iat, 60, 'join tokens live 60 s');
  assert.equal(v(f.token_utf8).payload.uname, f.uname_utf8);
  assert.equal(v(f.token, Number(f.expired_now)).reason, 'expired');
  assert.equal(v(f.token, Number(f.expired_now) - 1).ok, true);
  assert.equal(v(f.token_tampered).reason, 'signature');
  assert.equal(v(f.token_wrong_key).reason, 'signature');
  assert.equal(v(f.token_session).reason, 'typ');
  assert.equal(v(f.token_other_env).reason, 'env');
  // An independent check of the format, with no code from src/: what a Godot verifier will do.
  const [part, sig] = f.token.split('.');
  const mac = crypto.createHmac('sha256', Buffer.from(f.key_hex, 'hex')).update(Buffer.from(part, 'ascii')).digest();
  assert.equal(Buffer.from(sig, 'base64url').equals(mac), true);
  assert.ok(!f.token.includes('='), 'no padding');
});
