'use strict';
// POST /v1/session (spec 4.10, 4.8): one of
//   {login: {id, password}}              password login: issues a credential and a session
//   {credential: {user_id, token}, session?}   credential restore: a session (a refresh when `session` qualifies)
// optional `grant` (admission, M6; accepted and not yet checked). ok: {user:{id,username}, session:{token,expires_in}, credential?}.

const { fail, sendOk } = require('../../contract/envelope');
const { signSession, isSessionRefresh, nowSecFrom } = require('../../auth/tokens');
const { issueCredential, findUserByCredential, hashCredentialToken, isPlausibleToken } = require('../../auth/credentials');
const { verifyLogin } = require('../../storage/users');
const { getDB } = require('../../db');
const { route, isObject, body, parseUserId } = require('./util');

const ID_MAX = 255;
const PASSWORD_MAX = 1024;

function registerSessionRoutes(router, deps) {
  const { env, config, limiter, now, rateLimited } = deps;

  function sessionFor(user) {
    const s = signSession({ uid: user.user_id, env: env.ENV, nowSec: nowSecFrom(now()), keyHex: env.SESSION_KEY });
    return { token: s.token, expires_in: s.expires_in };
  }

  router.post('/session', route(async (req, res) => {
    const b = body(req);
    const limits = config().server.rate_limits;

    if (isObject(b.login)) {
      const { id, password } = b.login;
      if (typeof id !== 'string' || id.trim() === '' || id.length > ID_MAX
        || typeof password !== 'string' || password === '' || password.length > PASSWORD_MAX) {
        fail('VALIDATION', { message: 'Enter your username or email, and your password.' });
      }
      rateLimited(limiter.hit('login-ip', req.ip, limits.login_per_min_ip));
      rateLimited(limiter.hit('login-account', id.trim().toLowerCase(), limits.login_per_min_account));

      const user = await verifyLogin(id, password);
      if (!user) fail('AUTH_INVALID');
      const credential = await issueCredential(getDB(), {
        userId: user.user_id, platform: req.rjClient.platform, installId: req.rjClient.install,
      });
      sendOk(res, { user: { id: user.user_id, username: user.username }, session: sessionFor(user), credential });
      return;
    }

    if (isObject(b.credential)) {
      const userId = parseUserId(b.credential.user_id);
      const token = b.credential.token;
      if (userId === null || !isPlausibleToken(token)) {
        fail('VALIDATION', { message: "That sign-in couldn't be read. Please sign in again." });
      }
      rateLimited(limiter.hit('restore-credential', hashCredentialToken(token), limits.restore_per_min_credential));

      const user = await findUserByCredential(getDB(), { userId, token });
      if (!user) fail('AUTH_INVALID');
      // Admission (M6) lets a refresh through without queueing; nothing else differs yet.
      req.sessionRefresh = isSessionRefresh(b.session, {
        keyHex: env.SESSION_KEY, env: env.ENV, nowSec: nowSecFrom(now()), uid: user.user_id,
        graceSec: config().server.admission.session_refresh_grace_sec,
      });
      sendOk(res, { user: { id: user.user_id, username: user.username }, session: sessionFor(user) });
      return;
    }

    fail('VALIDATION', { message: 'Send a login or a credential.' });
  }));
}

module.exports = { registerSessionRoutes };
