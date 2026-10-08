'use strict';
// API v1 (spec 4.2-4.4, 4.8-4.10): the router mounted at /v1 on the public listener. In order:
//   1. requestId      the ref, its X-RJ-Ref header and the request's log line
//   2. clientHeaders  the five gates of spec 4.9, before the body is read and before auth
//   3. express.json   the body (64 KB at most)
//   4. the routes     each locked route checks the session itself (requireSession), then its rate limits
//   5. notFound, errors   everything that went wrong, as the envelope
// /v1/match/join and /v1/queue/:ticket (M4) are here when a match registry is given; the admission kind of
// /v1/queue arrives with M6.

const express = require('express');
const { fail } = require('../../contract/envelope');
const { requestId } = require('../../middleware/requestId');
const { clientHeaders } = require('../../middleware/clientHeaders');
const { requireSession } = require('../../middleware/auth');
const { createRateLimiter } = require('../../middleware/rateLimit');
const { errors, notFound } = require('../../middleware/errors');
const { registerSessionRoutes } = require('./session');
const { registerAccountRoutes } = require('./accounts');
const { registerMeRoutes } = require('./me');
const { registerUserRoutes } = require('./users');
const { registerMatchRoutes } = require('./match');

const BODY_LIMIT = '64kb';

function rateLimited(r) {
  if (!r.ok) fail('RATE_LIMITED', { retry: { kind: 'after', after_ms: r.retryAfterMs } });
}

// env: config/env.js's (ENV and SESSION_KEY are used); remote: config/remote.js's createRemoteConfig().
// match: match/registry.js's createMatchRegistry() (optional); findUser: tests' stand-in for the users table.
function createV1Router({ env, remote, now = () => Date.now(), limiter = createRateLimiter({ now }), match = null, findUser }) {
  if (!env.SESSION_KEY) throw new Error('/v1 needs SESSION_KEY');
  const config = () => remote.current();
  const router = express.Router();

  router.use(requestId());
  router.use(clientHeaders({ serverEnv: env.ENV, config, now }));
  router.use(express.json({ limit: BODY_LIMIT }));

  const deps = {
    env, config, now, limiter, rateLimited,
    requireSession: requireSession({ keyHex: env.SESSION_KEY, serverEnv: env.ENV, now }),
  };
  registerSessionRoutes(router, deps);
  registerAccountRoutes(router, deps);
  registerMeRoutes(router, deps);
  registerUserRoutes(router, deps);
  if (match) registerMatchRoutes(router, { ...deps, match, ...(findUser ? { findUser } : {}) });

  router.use(notFound);
  router.use(errors({ config }));
  return router;
}

module.exports = { createV1Router, BODY_LIMIT };
