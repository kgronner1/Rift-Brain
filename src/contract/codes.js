'use strict';
// The error code registry (spec 4.3): code -> default message, title, retry, scope, action and HTTP status.
// Routes raise fail('LOBBY_FULL') or fail('VALIDATION', { message }); envelope.js fills the rest from here, and
// config `messages.<CODE>` overrides the text (spec 4.5).
//
// Section 4 is a contract: a code is added, never renamed or removed, and its retry/scope/action never change.
// The realtime codes the game server sends live in Wobble Planet's Scripts/Net/HandshakeCodes.gd; the codes both
// registries share must agree (a test there and here: test/contract.test.js pins this table to the spec).
//
// `channels` says where a code is sent: 'http' (a /v1 response), 'handshake' (the game server's reply, M4), or
// both. Handshake-only codes are here so the two registries can be compared in one place; they have no status.

const RETRY_KINDS = Object.freeze(['never', 'backoff', 'after']);
const SCOPES = Object.freeze(['request', 'multiplayer', 'account', 'app']);
const ACTION_KINDS = Object.freeze(['dismiss', 'retry', 'open_url', 'open_store', 'login']);
const MESSAGE_MAX = 280;

const FIVE_MIN_MS = 5 * 60 * 1000;

const CODES = Object.freeze({
  UPDATE_REQUIRED: {
    status: 426,
    channels: ['http'],
    title: 'Update required',
    message: 'This version of Rift Jumpers is too old to play online. Update to keep playing.',
    retry: { kind: 'never' },
    // 'app' when the build is below min_build; clientHeaders passes it.
    scope: 'multiplayer',
    action: { kind: 'open_store', label: 'Update' },
  },
  SERVER_BEHIND: {
    status: 503,
    channels: ['http'],
    title: 'Servers updating',
    message: "The servers haven't caught up with this version of Rift Jumpers yet. Please try again in a few minutes.",
    retry: { kind: 'after', after_ms: FIVE_MIN_MS },
    scope: 'multiplayer',
    action: { kind: 'dismiss' },
  },
  MAINTENANCE: {
    status: 503,
    channels: ['http'],
    title: 'Maintenance',
    message: 'Rift Jumpers is down for maintenance. Please try again soon.',
    // after_ms runs until gates.maintenance.ends_at; clientHeaders passes it, and the scope, from config.
    retry: { kind: 'after', after_ms: FIVE_MIN_MS },
    scope: 'multiplayer',
    action: { kind: 'dismiss' },
  },
  ENV_MISMATCH: {
    status: 421,
    channels: ['http', 'handshake'],
    title: 'Wrong servers',
    message: "This build of Rift Jumpers is talking to the wrong servers. Please reinstall it from the store.",
    retry: { kind: 'never' },
    scope: 'app',
    handshakeScope: 'multiplayer',
    action: { kind: 'dismiss' },
  },
  API_UNSUPPORTED: {
    status: 400,
    channels: ['http'],
    title: 'Update required',
    message: "This version of Rift Jumpers can't talk to the servers any more. Update to keep playing.",
    retry: { kind: 'never' },
    scope: 'app',
    action: { kind: 'open_store', label: 'Update' },
  },
  AUTH_REQUIRED: {
    status: 401,
    channels: ['http'],
    title: 'Signed out',
    message: 'Please sign in to continue.',
    retry: { kind: 'never' },
    scope: 'account',
    action: { kind: 'login', label: 'Sign in' },
  },
  AUTH_EXPIRED: {
    status: 401,
    channels: ['http'],
    title: 'Signed out',
    message: 'Your session has ended. Please sign in again.',
    retry: { kind: 'never' },
    scope: 'account',
    action: { kind: 'login', label: 'Sign in' },
  },
  AUTH_INVALID: {
    status: 401,
    channels: ['http'],
    title: "Couldn't sign in",
    message: "That username, email or password isn't right.",
    retry: { kind: 'never' },
    scope: 'account',
    action: { kind: 'login', label: 'Sign in' },
  },
  VALIDATION: {
    status: 400,
    channels: ['http'],
    message: "Something in that request wasn't right. Please check it and try again.",
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'dismiss' },
  },
  RATE_LIMITED: {
    status: 429,
    channels: ['http'],
    title: 'Slow down',
    message: 'Too many attempts. Please wait a minute and try again.',
    retry: { kind: 'after', after_ms: 60 * 1000 },
    scope: 'request',
    action: { kind: 'dismiss' },
  },
  LOBBY_NOT_FOUND: {
    status: 404,
    channels: ['http'],
    message: "There's no lobby with that code.",
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'dismiss' },
  },
  LOBBY_FULL: {
    status: 409,
    channels: ['http', 'handshake'],
    message: 'That lobby is full.',
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'dismiss' },
  },
  LOBBY_WRONG_VERSION: {
    status: 409,
    channels: ['http'],
    message: 'That lobby is running a different version of Rift Jumpers.',
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'open_store', label: 'Update' },
  },
  NO_CAPACITY: {
    status: 503,
    channels: ['http'],
    message: 'All the servers are busy right now. Please try again in a moment.',
    retry: { kind: 'backoff' },
    scope: 'request',
    action: { kind: 'retry', label: 'Try again' },
  },
  QUEUE_TICKET_INVALID: {
    status: 404,
    channels: ['http'],
    message: 'Your place in line has expired.',
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'dismiss' },
  },
  INTERNAL: {
    status: 500,
    channels: ['http'],
    message: 'Something went wrong on our side. Please try again.',
    retry: { kind: 'backoff' },
    scope: 'request',
    action: { kind: 'retry', label: 'Try again' },
  },
  HANDSHAKE_UNSUPPORTED: {
    status: null,
    channels: ['handshake'],
    message: "This version of Rift Jumpers can't join this match. Update to keep playing.",
    retry: { kind: 'never' },
    scope: 'multiplayer',
    action: { kind: 'open_store', label: 'Update' },
  },
  WIRE_MISMATCH: {
    status: null,
    channels: ['handshake'],
    message: "This version of Rift Jumpers can't join this match. Update to keep playing.",
    retry: { kind: 'never' },
    scope: 'multiplayer',
    // open_store when the client is older, dismiss when it is newer: the game server picks.
    action: { kind: 'open_store', label: 'Update' },
  },
  JOIN_TOKEN_INVALID: {
    status: null,
    channels: ['handshake'],
    message: "Couldn't join the match. Please try again.",
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'retry', label: 'Try again' },
  },
  JOIN_TOKEN_EXPIRED: {
    status: null,
    channels: ['handshake'],
    message: 'Joining took too long. Please try again.',
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'retry', label: 'Try again' },
  },
  MATCH_IN_PROGRESS: {
    status: null,
    channels: ['handshake'],
    message: 'That match has already started.',
    retry: { kind: 'never' },
    scope: 'request',
    action: { kind: 'retry', label: 'Try again' },
  },
});

function entry(code) {
  return Object.prototype.hasOwnProperty.call(CODES, code) ? CODES[code] : null;
}

function isHttpCode(code) {
  const e = entry(code);
  return !!e && e.channels.includes('http');
}

module.exports = { CODES, RETRY_KINDS, SCOPES, ACTION_KINDS, MESSAGE_MAX, entry, isHttpCode };
