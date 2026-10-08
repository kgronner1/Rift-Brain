'use strict';
// log.js: tokens and credentials never reach a log line (spec D2, M3).
const test = require('node:test');
const assert = require('node:assert/strict');
const log = require('../src/log');
const { signSession } = require('../src/auth/tokens');
const { newCredentialToken } = require('../src/auth/credentials');

const SESSION = signSession({ uid: 1, env: 'dev', nowSec: 1790000000, keyHex: 'ab'.repeat(32) }).token;
const CRED = newCredentialToken();

function captured(t, fn) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.join(' ')));
  fn();
  return lines.join('\n');
}

test('values under a secret-named key are replaced at any depth', () => {
  const out = log.redact({
    login: { id: 'pilot', password: 'hunter2' },
    credential: { user_id: 1, token: CRED },
    session: SESSION,
    nested: { deeper: [{ access_token: 'abc', Authorization: 'Bearer x' }] },
    grant: 'g',
    stats: { sp_x: 1 },
  });
  assert.deepEqual(out, {
    login: { id: 'pilot', password: '[redacted]' },
    credential: '[redacted]',
    session: '[redacted]',
    nested: { deeper: [{ access_token: '[redacted]', Authorization: '[redacted]' }] },
    grant: '[redacted]',
    stats: { sp_x: 1 },
  });
});

test('strings: our tokens, Bearer values and secret query parameters are replaced', () => {
  assert.equal(log.redactString(`got ${SESSION} here`), 'got [redacted] here');
  assert.equal(log.redactString('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]');
  assert.equal(log.redactString('GET /x?ticket_id=5&access_token=abcdef&x=1'), 'GET /x?ticket_id=5&access_token=[redacted]&x=1');
  assert.equal(log.redactString('password=hunter2'), 'password=[redacted]');
  assert.equal(log.redactString('Ticket 3f2a admitted to game instance 8080'), 'Ticket 3f2a admitted to game instance 8080');
});

test('nothing secret reaches the console through any level, objects and errors included', (t) => {
  const text = captured(t, () => {
    log.info('body', { login: { id: 'p', password: 'hunter2' }, credential: { user_id: 1, token: CRED } });
    log.warn(`session ${SESSION}`);
    log.error('failed:', new Error(`verify failed for ${SESSION}`));
    log.stream.write(`POST /passive_login_user?access_token=${CRED} 200\n`);
  });
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes(CRED), text);
  assert.ok(!text.includes(SESSION), text);
  assert.ok(text.includes('[redacted]'));
  assert.ok(text.includes('verify failed for [redacted]'));
});

test('cycles and depth do not throw', () => {
  const a = { x: 1 };
  a.self = a;
  assert.equal(log.redact(a).self, '[circular]');
  assert.doesNotThrow(() => log.format([{ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }]));
});
