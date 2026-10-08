'use strict';
// POST /v1/accounts (spec 4.10): {username, email, password}, optional `grant` (M6). Today's rules, as VALIDATION.
// ok: as /v1/session, plus the credential.

const { fail, sendOk } = require('../../contract/envelope');
const { signSession, nowSecFrom } = require('../../auth/tokens');
const { createAccount } = require('../../storage/users');
const { route, body } = require('./util');

// The messages checkNewUser() throws for bad input; anything else is a fault (INTERNAL).
const RULE_MESSAGE_RE = /^(Missing required field|Username is not allowed|This username|Invalid email format|This email is already registered)/;
const FIELD_MAX = { username: 64, email: 255, password: 1024 };

function registerAccountRoutes(router, deps) {
  const { env, config, limiter, now, rateLimited } = deps;

  router.post('/accounts', route(async (req, res) => {
    const b = body(req);
    const limits = config().server.rate_limits;
    rateLimited(limiter.hit('accounts-ip', req.ip, limits.login_per_min_ip));
    for (const k of ['username', 'email']) {
      if (typeof b[k] === 'string' && b[k] !== '') rateLimited(limiter.hit(`accounts-${k}`, b[k].trim().toLowerCase(), limits.login_per_min_account));
    }
    for (const [k, max] of Object.entries(FIELD_MAX)) {
      if (typeof b[k] === 'string' && b[k].length > max) fail('VALIDATION', { message: `That ${k} is too long.` });
    }

    let account;
    try {
      account = await createAccount({ username: b.username, email: b.email, password: b.password },
        { platform: req.rjClient.platform, installId: req.rjClient.install });
    } catch (error) {
      if (error && RULE_MESSAGE_RE.test(String(error.message))) fail('VALIDATION', { message: error.message });
      throw error;
    }
    const s = signSession({ uid: account.user_id, env: env.ENV, nowSec: nowSecFrom(now()), keyHex: env.SESSION_KEY });
    sendOk(res, {
      user: { id: account.user_id, username: account.username },
      session: { token: s.token, expires_in: s.expires_in },
      credential: account.credential,
    });
  }));
}

module.exports = { registerAccountRoutes };
