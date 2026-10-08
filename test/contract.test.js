'use strict';
// Spec section 4 pinned: the envelope's exact shapes (4.2), the code registry against the 4.3 table, and the
// fallbacks the client keys on. A failure here means a contract changed: section 4 needs Alex and Kyler.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CODES, RETRY_KINDS, SCOPES, ACTION_KINDS, MESSAGE_MAX } = require('../src/contract/codes');
const { buildError, ok, queued, fail, ApiError } = require('../src/contract/envelope');

// Spec 4.3, row by row: code -> [retry.kind, scope, action.kind]. Variants the spec names are in the comments and
// in their own tests below.
const SPEC_4_3 = {
  UPDATE_REQUIRED: ['never', 'multiplayer', 'open_store'], // scope app below min_build
  SERVER_BEHIND: ['after', 'multiplayer', 'dismiss'], // after 5 min
  MAINTENANCE: ['after', 'multiplayer', 'dismiss'], // scope from config, after until ends_at
  ENV_MISMATCH: ['never', 'app', 'dismiss'], // multiplayer at the handshake
  API_UNSUPPORTED: ['never', 'app', 'open_store'],
  AUTH_REQUIRED: ['never', 'account', 'login'],
  AUTH_EXPIRED: ['never', 'account', 'login'],
  AUTH_INVALID: ['never', 'account', 'login'],
  VALIDATION: ['never', 'request', 'dismiss'],
  RATE_LIMITED: ['after', 'request', 'dismiss'],
  LOBBY_NOT_FOUND: ['never', 'request', 'dismiss'],
  LOBBY_FULL: ['never', 'request', 'dismiss'],
  LOBBY_WRONG_VERSION: ['never', 'request', 'open_store'],
  NO_CAPACITY: ['backoff', 'request', 'retry'],
  QUEUE_TICKET_INVALID: ['never', 'request', 'dismiss'],
  INTERNAL: ['backoff', 'request', 'retry'],
  HANDSHAKE_UNSUPPORTED: ['never', 'multiplayer', 'open_store'],
  WIRE_MISMATCH: ['never', 'multiplayer', 'open_store'], // dismiss when the client is newer
  JOIN_TOKEN_INVALID: ['never', 'request', 'retry'],
  JOIN_TOKEN_EXPIRED: ['never', 'request', 'retry'],
  MATCH_IN_PROGRESS: ['never', 'request', 'retry'],
};
const HANDSHAKE_ONLY = ['HANDSHAKE_UNSUPPORTED', 'WIRE_MISMATCH', 'JOIN_TOKEN_INVALID', 'JOIN_TOKEN_EXPIRED', 'MATCH_IN_PROGRESS'];

test('the registry holds exactly the codes of spec 4.3', () => {
  assert.deepEqual(Object.keys(CODES).sort(), Object.keys(SPEC_4_3).sort());
});

test('every code has the retry, scope and action of spec 4.3', () => {
  for (const [code, [retry, scope, action]] of Object.entries(SPEC_4_3)) {
    const e = CODES[code];
    assert.equal(e.retry.kind, retry, `${code} retry`);
    assert.equal(e.scope, scope, `${code} scope`);
    assert.equal(e.action.kind, action, `${code} action`);
  }
  assert.equal(CODES.SERVER_BEHIND.retry.after_ms, 5 * 60 * 1000, 'SERVER_BEHIND waits 5 minutes');
  assert.equal(CODES.ENV_MISMATCH.handshakeScope, 'multiplayer');
});

test('every entry is well formed: known vocabulary, a short message, a status for every HTTP code', () => {
  for (const [code, e] of Object.entries(CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(RETRY_KINDS.includes(e.retry.kind), code);
    assert.ok(SCOPES.includes(e.scope), code);
    assert.ok(ACTION_KINDS.includes(e.action.kind), code);
    assert.ok(typeof e.message === 'string' && e.message.length > 0 && e.message.length <= MESSAGE_MAX, code);
    assert.ok(/^[A-Z]/.test(e.message), `${code}: sentence case`);
    if (e.retry.kind === 'after') assert.ok(Number.isInteger(e.retry.after_ms) && e.retry.after_ms > 0, code);
    if (HANDSHAKE_ONLY.includes(code)) {
      assert.deepEqual(e.channels, ['handshake'], code);
      assert.equal(e.status, null, code);
    } else {
      assert.ok(e.channels.includes('http'), code);
      assert.ok(Number.isInteger(e.status) && e.status >= 400 && e.status < 600, `${code} status ${e.status}`);
    }
  }
  assert.deepEqual(CODES.LOBBY_FULL.channels, ['http', 'handshake']);
  assert.deepEqual(CODES.ENV_MISMATCH.channels, ['http', 'handshake']);
});

test('statuses: 429 and 503 carry Retry-After only with retry after (spec 4.2: the client reads it as retry.after)', () => {
  assert.equal(CODES.RATE_LIMITED.status, 429);
  for (const [code, e] of Object.entries(CODES)) {
    if (e.status === null) continue;
    const { headers } = buildError(code, {}, { ref: 'r-1' });
    assert.equal('Retry-After' in headers, e.retry.kind === 'after', code);
  }
  assert.equal(CODES.NO_CAPACITY.status, 503);
  assert.equal(buildError('NO_CAPACITY').headers['Retry-After'], undefined, 'backoff on a 503 must not say Retry-After');
});

test('the ok envelope is exactly {result, data}', () => {
  assert.deepEqual(ok({ a: 1 }), { result: 'ok', data: { a: 1 } });
  assert.deepEqual(Object.keys(ok()), ['result', 'data']);
});

test('the error envelope is exactly {result, error:{code, message, title?, retry, scope, action, ref}}', () => {
  const { status, body, headers } = buildError('UPDATE_REQUIRED', {}, { ref: 'r-7f3a9c' });
  assert.equal(status, 426);
  assert.deepEqual(headers, {});
  assert.deepEqual(body, {
    result: 'error',
    error: {
      code: 'UPDATE_REQUIRED',
      message: 'This version of Rift Jumpers is too old to play online. Update to keep playing.',
      title: 'Update required',
      retry: { kind: 'never' },
      scope: 'multiplayer',
      action: { kind: 'open_store', label: 'Update' },
      ref: 'r-7f3a9c',
    },
  });
  assert.deepEqual(Object.keys(body), ['result', 'error']);

  const v = buildError('VALIDATION', { message: 'This username "x" is already taken.' }, { ref: 'r-2' }).body.error;
  assert.deepEqual(Object.keys(v), ['code', 'message', 'retry', 'scope', 'action', 'ref'], 'no title when there is none');

  const r = buildError('RATE_LIMITED', { retry: { kind: 'after', after_ms: 1500.4 } }, { ref: 'r-3' });
  assert.deepEqual(r.body.error.retry, { kind: 'after', after_ms: 1500 });
  assert.equal(r.headers['Retry-After'], '2');
});

test('the queued envelope is exactly {result, queued:{ticket, kind, position, eta_sec, poll_after_ms, expires_in_sec, message}}', () => {
  assert.deepEqual(queued({ ticket: 'q_5b0f', kind: 'admission', position: 132, eta_sec: 95, poll_after_ms: 4700,
    expires_in_sec: 600, message: "Lots of pilots are launching right now. You're in line." }), {
    result: 'queued',
    queued: { ticket: 'q_5b0f', kind: 'admission', position: 132, eta_sec: 95, poll_after_ms: 4700, expires_in_sec: 600,
      message: "Lots of pilots are launching right now. You're in line." },
  });
});

test('messages: a route\'s own beats config messages.<CODE>, which beats the registry; at most 280 characters', () => {
  const messages = { VALIDATION: { message: 'Config text.', title: 'Config title' }, INTERNAL: { message: 'Oops.', action: { kind: 'dismiss' } } };
  assert.equal(buildError('VALIDATION', { message: 'Route text.' }, { messages }).body.error.message, 'Route text.');
  assert.equal(buildError('VALIDATION', {}, { messages }).body.error.message, 'Config text.');
  assert.equal(buildError('VALIDATION', {}, { messages }).body.error.title, 'Config title');
  assert.deepEqual(buildError('INTERNAL', {}, { messages }).body.error.action, { kind: 'dismiss' });
  assert.equal(buildError('AUTH_INVALID', {}, { messages }).body.error.message, CODES.AUTH_INVALID.message);
  const long = buildError('VALIDATION', { message: 'x'.repeat(500) }).body.error.message;
  assert.equal(long.length, MESSAGE_MAX);
});

test('an unknown or handshake-only code never reaches a client as itself: it is INTERNAL', () => {
  assert.equal(buildError('NOT_A_CODE').body.error.code, 'INTERNAL');
  assert.equal(buildError('JOIN_TOKEN_INVALID').body.error.code, 'INTERNAL');
  assert.equal(buildError('NOT_A_CODE').status, 500);
});

test('fail() raises an ApiError carrying its code and options', () => {
  assert.throws(() => fail('LOBBY_FULL'), (e) => e instanceof ApiError && e.code === 'LOBBY_FULL');
  assert.throws(() => fail('VALIDATION', { message: 'm' }), (e) => e.opts.message === 'm');
});
