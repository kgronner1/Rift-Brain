'use strict';
// POST /v1/session (spec 4.10, 4.8): one of
//   {login: {id, password}}              password login: issues a credential and a session
//   {credential: {user_id, token}, session?}   credential restore: a session (a refresh when `session` qualifies)
// optional `grant` (admission, M6: when on, a request that is neither a refresh nor carrying a valid grant may answer
// `queued`; it runs after the input checks and rate limits, before the database).
// ok: {user:{id,username,guest}, session:{token,expires_in}, credential?}. A password login never matches a guest
// (RJ 493: no email, no password), so its `guest` is false; a restore reports the account's.
//
// POST /v1/session/revoke {credential: {user_id, token}} (RJ 506): logging out. A gap-fill, additive to spec 4.10 --
// the spec has the credential revocable (4.8) but no route that revokes one. The choices:
//   - Authenticated by the credential itself, the restore's shape, not by a session: a device whose one-hour session
//     has lapsed can still log out. A bearer, if sent, is ignored.
//   - Sets that credential's revoked_at (only that one: the account's other devices stay signed in), and every later
//     restore of it is AUTH_INVALID. A session already issued is stateless and lives out its hour.
//   - ok {} whether the credential was live, already revoked, unknown, or names another user: the answer says nothing
//     about which. VALIDATION for one that cannot be read (as the restore); RATE_LIMITED per credential
//     (restore_per_min_credential, in a bucket of its own). No admission; not a multiplayer route.
//   - Not DELETE /v1/session: what is revoked is the credential, and the session it would name is stateless.
// credentials: { revoke({userId, token}) -> bool } (auth/credentials.js's revokeCredential); tests pass their own.

const { fail, sendOk } = require('../../contract/envelope');
const { signSession, isSessionRefresh, nowSecFrom } = require('../../auth/tokens');
const { issueCredential, findUserByCredential, revokeCredential, hashCredentialToken, isPlausibleToken } = require('../../auth/credentials');
const log = require('../../log');
const { verifyLogin } = require('../../storage/users');
const { getDB } = require('../../db');
const { route, isObject, body, parseUserId, admitted } = require('./util');

const ID_MAX = 255;
const PASSWORD_MAX = 1024;

const DATABASE_CREDENTIALS = { revoke: (c) => revokeCredential(getDB(), c) };

// {credential: {user_id, token}} as the restore and the revoke read it: {userId, token}, or VALIDATION.
function readCredential(c) {
  const userId = isObject(c) ? parseUserId(c.user_id) : null;
  const token = isObject(c) ? c.token : undefined;
  if (userId === null || !isPlausibleToken(token)) {
    fail('VALIDATION', { message: "That sign-in couldn't be read. Please sign in again." });
  }
  return { userId, token };
}

function registerSessionRoutes(router, deps) {
  const { env, config, limiter, now, rateLimited, admission, credentials = DATABASE_CREDENTIALS } = deps;

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
      sendOk(res, { user: { id: user.user_id, username: user.username, guest: user.guest }, session: sessionFor(user), credential });
      return;
    }

    if (isObject(b.credential)) {
      const { userId, token } = readCredential(b.credential);
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
      sendOk(res, { user: { id: user.user_id, username: user.username, guest: user.guest }, session: sessionFor(user) });
      return;
    }

    fail('VALIDATION', { message: 'Send a login or a credential.' });
  }));

  router.post('/session/revoke', route(async (req, res) => {
    const { userId, token } = readCredential(body(req).credential);
    rateLimited(limiter.hit('revoke-credential', hashCredentialToken(token), config().server.rate_limits.restore_per_min_credential));
    if (await credentials.revoke({ userId, token })) log.info(`[session] user ${userId} revoked a credential`);
    sendOk(res, {});
  }));
}

module.exports = { registerSessionRoutes, PASSWORD_MAX };
