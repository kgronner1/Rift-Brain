'use strict';
// Session-only routes (the lock in spec 4.10): a session token in `Authorization: Bearer <token>` (spec 4.8, 4.9).
//   no token, a malformed one, a bad signature, another type or another env -> AUTH_REQUIRED
//   a validly signed session past its exp                                     -> AUTH_EXPIRED
// The client restores its session once and replays the call once on either (spec 4.3 †).

const { fail } = require('../contract/envelope');
const { verifySession, nowSecFrom } = require('../auth/tokens');

function bearer(req) {
  const h = req.get('Authorization');
  if (typeof h !== 'string') return null;
  const m = h.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

function requireSession({ keyHex, serverEnv, now = () => Date.now() }) {
  return function requireSessionMiddleware(req, res, next) {
    try {
      const token = bearer(req);
      if (!token) fail('AUTH_REQUIRED');
      const r = verifySession(token, { keyHex, env: serverEnv, nowSec: nowSecFrom(now()) });
      if (!r.ok) fail(r.reason === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED');
      if (!Number.isInteger(r.payload.uid) || r.payload.uid <= 0) fail('AUTH_REQUIRED');
      req.session = { uid: r.payload.uid, iat: r.payload.iat, exp: r.payload.exp };
      next();
    } catch (e) {
      next(e);
    }
  };
}

// A route where the session is optional (RJ 488, /v1/feedback): no bearer token -> req.session = null and on; a bearer
// token is held to requireSession's rules, so a bad or expired one answers AUTH_REQUIRED / AUTH_EXPIRED and the client
// restores and replays as on a locked route. An Authorization header that is not a bearer token counts as none.
function optionalSession(opts) {
  const required = requireSession(opts);
  return function optionalSessionMiddleware(req, res, next) {
    if (bearer(req) === null) {
      req.session = null;
      next();
      return;
    }
    required(req, res, next);
  };
}

module.exports = { requireSession, optionalSession, bearer };
