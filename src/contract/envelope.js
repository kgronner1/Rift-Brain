'use strict';
// The /v1 response envelope (spec 4.2): every response is one of
//   { result: "ok",     data: {...} }                      200
//   { result: "error",  error: { code, message, title?, retry, scope, action, ref } }   4xx/5xx
//   { result: "queued", queued: { ticket, kind, position, eta_sec, poll_after_ms, expires_in_sec, message } }  202
// The client keys on the body; HTTP status is for logs and proxies.

const { entry, MESSAGE_MAX } = require('./codes');

class ApiError extends Error {
  constructor(code, opts = {}) {
    super(`${code}${opts.message ? `: ${opts.message}` : ''}`);
    this.name = 'ApiError';
    this.code = code;
    this.opts = opts;
  }
}

// Routes raise fail('LOBBY_FULL') or fail('VALIDATION', { message }); the registry fills the rest.
// opts: message, title, retry ({kind, after_ms?}), scope, action ({kind, label?, url?}), status.
function fail(code, opts = {}) {
  throw new ApiError(code, opts);
}

function clampMessage(s) {
  const text = String(s).replace(/\s+/g, ' ').trim();
  return text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX - 1)}…`;
}

function copyAction(a) {
  const out = { kind: a.kind };
  if (typeof a.label === 'string' && a.label !== '') out.label = a.label;
  if (typeof a.url === 'string' && a.url !== '') out.url = a.url;
  return out;
}

function copyRetry(r) {
  const out = { kind: r.kind };
  if (r.kind === 'after') out.after_ms = Math.max(0, Math.round(Number(r.after_ms) || 0));
  return out;
}

// The error body and its HTTP status and headers. A route's own message wins over config `messages.<CODE>`, which
// wins over the registry's default (a VALIDATION's "username taken" must not be replaced by a generic override).
// An unknown code is a bug in the brain, so it becomes INTERNAL rather than an envelope the client cannot read.
function buildError(code, opts = {}, { ref, messages } = {}) {
  let reg = entry(code);
  if (!reg || reg.status === null) {
    code = 'INTERNAL';
    opts = {};
    reg = entry('INTERNAL');
  }
  const override = messages && typeof messages === 'object' && messages[code] && typeof messages[code] === 'object'
    ? messages[code] : null;

  const message = opts.message || (override && override.message) || reg.message;
  const title = opts.title !== undefined ? opts.title : (override && override.title !== undefined ? override.title : reg.title);
  const action = opts.action || (override && override.action) || reg.action;
  const retry = opts.retry || reg.retry;

  const error = { code, message: clampMessage(message) };
  if (typeof title === 'string' && title !== '') error.title = clampMessage(title);
  error.retry = copyRetry(retry);
  error.scope = opts.scope || reg.scope;
  error.action = copyAction(action);
  error.ref = ref || '';

  const headers = {};
  if (error.retry.kind === 'after') headers['Retry-After'] = String(Math.ceil(error.retry.after_ms / 1000));
  return { status: opts.status || reg.status, headers, body: { result: 'error', error } };
}

function ok(data = {}) {
  return { result: 'ok', data };
}

function queued(q) {
  const out = {
    ticket: String(q.ticket),
    kind: String(q.kind),
    position: Math.max(0, Math.round(Number(q.position) || 0)),
    eta_sec: Math.max(0, Math.round(Number(q.eta_sec) || 0)),
    poll_after_ms: Math.max(0, Math.round(Number(q.poll_after_ms) || 0)),
    expires_in_sec: Math.max(0, Math.round(Number(q.expires_in_sec) || 0)),
    message: clampMessage(q.message || ''),
  };
  return { result: 'queued', queued: out };
}

// Express helpers.
function sendOk(res, data) {
  res.status(200).json(ok(data));
}

function sendQueued(res, q) {
  res.status(202).json(queued(q));
}

module.exports = { ApiError, fail, buildError, ok, queued, sendOk, sendQueued, clampMessage };
