'use strict';
// Every log line the brain writes goes through here (spec M0/M3, D2 "scrubbed logs"). A value under a key that
// names a secret is replaced, at any depth, and so is anything in a string that looks like one of our tokens, a
// Bearer header or a token-ish query parameter. Tokens and credentials never reach a log file.

const util = require('util');

const SECRET_KEY_RE = /password|token|credential|authorization|grant|session/i;
const REDACTED = '[redacted]';
// base64url(payload) "." base64url(HMAC): spec 4.8's token format. The HMAC half is 43 characters.
const TOKEN_RE = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const BEARER_RE = /(bearer\s+)[^\s"',;]+/gi;
const QUERY_SECRET_RE = /([?&;\s"']?(?:[a-z_]*(?:password|token|credential|grant|session)[a-z_]*)["']?\s*[=:]\s*["']?)[^&\s"',;}]+/gi;
const MAX_DEPTH = 6;

function redactString(s) {
  return s.replace(TOKEN_RE, REDACTED).replace(BEARER_RE, `$1${REDACTED}`).replace(QUERY_SECRET_RE, `$1${REDACTED}`);
}

function redact(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[deep]';
  seen.add(value);
  if (value instanceof Error) {
    const out = new Error(redactString(String(value.message)));
    out.name = value.name;
    out.stack = value.stack ? redactString(String(value.stack)) : undefined;
    if (value.code !== undefined) out.code = value.code;
    return out;
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}]`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

// One line per call: objects are formatted here, after redaction, so nothing unredacted reaches console.
function format(args) {
  return args.map((a) => (typeof a === 'string' ? redactString(a) : util.inspect(redact(a), { depth: MAX_DEPTH, breakLength: Infinity }))).join(' ');
}

const sink = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

module.exports = {
  info: (...args) => sink.info(format(args)),
  warn: (...args) => sink.warn(format(args)),
  error: (...args) => sink.error(format(args)),
  // morgan's stream for the legacy routes' access lines.
  stream: { write: (s) => sink.info(redactString(String(s).replace(/\n$/, ''))) },
  redact,
  redactString,
  format,
  REDACTED,
};
