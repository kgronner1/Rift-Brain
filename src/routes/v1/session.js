'use strict';
// POST /v1/session (spec 4.10, 4.8): one of
//   {login: {id, password}}              password login: issues a credential and a session
//   {credential: {user_id, token}, session?}   credential restore: a session (a refresh when `session` qualifies)
// optional `grant` (admission, M6: when on, a request that is neither a refresh nor carrying a valid grant may answer
// `queued`; it runs after the input checks and rate limits, before the database). ok: {user:{id,username}, session:{token,expires_in}, credential?}.

const { fail, sendOk } = require('../../contract/envelope');
const { signSession, isSessionRefresh, nowSecFrom } = require('../../auth/tokens');
const { issueCredential, findUserByCredential, hashCredentialToken, isPlausibleToken } = require('../../auth/credentials');
const { verifyLogin } = require('../../storage/users');
const { getDB } = require('../../db');
const { route, isObject, body, parseUserId, admitted } = require('./util');

const ID_MAX = 255;
const PASSWORD_MAX = 1024;

function registerSessionRoutes(router, deps) {
  const { env, config, limiter, now, rateLimited, admission } = deps;

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
      if (!admitted(admission, req, res, { grant: b.grant })) return;

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

      // A refresh (spec 4.8) skips admission. Its session must have been issued to the user the credential names;
      // the credential itself is checked next, so a refresh with someone else's credential still fails.
      const refresh = isSessionRefresh(b.session, {
        keyHex: env.SESSION_KEY, env: env.ENV, nowSec: nowSecFrom(now()), uid: userId,
        graceSec: config().server.admission.session_refresh_grace_sec,
      });
      if (!admitted(admission, req, res, { grant: b.grant, refresh })) return;

      const user = await findUserByCredential(getDB(), { userId, token });
      if (!user) fail('AUTH_INVALID');
      sendOk(res, { user: { id: user.user_id, username: user.username }, session: sessionFor(user) });
      return;
    }

    fail('VALIDATION', { message: 'Send a login or a credential.' });
  }));
}

module.exports = { registerSessionRoutes };
