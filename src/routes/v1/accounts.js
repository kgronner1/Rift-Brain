'use strict';
// POST /v1/accounts (spec 4.10): {username, email, password}, optional `grant` (M6: admission may answer `queued` first). Today's rules, as VALIDATION.
// ok: as /v1/session, plus the credential.
//
// {guest: true} (RJ 493) makes a guest instead: username, email and password are ignored, and the account is named
// Pilot-NNNN with no email or password. In order: flags.guest_play false -> VALIDATION (the kill switch is the
// brain's, not only the clients'); accounts-ip per minute (login_per_min_ip); admission as for an account; then
// guest_per_day_ip, a fixed 24-hour window per IP, counted only for a request admission let through (a queued one
// comes back with its grant and is counted then). ok: {user:{id, username, guest:true}, session, credential}.

const { fail, sendOk } = require('../../contract/envelope');
const { signSession, nowSecFrom } = require('../../auth/tokens');
const { DAY_MS } = require('../../middleware/rateLimit');
const { createAccount, createGuest } = require('../../storage/users');
const { route, body, admitted } = require('./util');

// The messages checkNewUser() throws for bad input; anything else is a fault (INTERNAL).
const RULE_MESSAGE_RE = /^(Missing required field|Username is not allowed|That username is reserved|This username|Invalid email format|This email is already registered)/;
const FIELD_MAX = { username: 64, email: 255, password: 1024 };
const GUEST_PLAY_OFF = 'Guest play is off right now. Log in or create an account.';

// The per-minute limits account creation and a guest's upgrade share: per IP, and per username and email given.
function accountLimits(req, b, { limiter, rateLimited, limits }) {
  rateLimited(limiter.hit('accounts-ip', req.ip, limits.login_per_min_ip));
  for (const k of ['username', 'email']) {
    if (typeof b[k] === 'string' && b[k] !== '') rateLimited(limiter.hit(`accounts-${k}`, b[k].trim().toLowerCase(), limits.login_per_min_account));
  }
}

function checkFieldMax(b) {
  for (const [k, max] of Object.entries(FIELD_MAX)) {
    if (typeof b[k] === 'string' && b[k].length > max) fail('VALIDATION', { message: `That ${k} is too long.` });
  }
}

// A storage call that may throw checkNewUser's rule messages: those become VALIDATION, anything else is a fault.
async function withRules(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error && RULE_MESSAGE_RE.test(String(error.message))) fail('VALIDATION', { message: error.message });
    throw error;
  }
}

function registerAccountRoutes(router, deps) {
  const { env, config, limiter, now, rateLimited, admission } = deps;

  function sessionFor(userId) {
    const s = signSession({ uid: userId, env: env.ENV, nowSec: nowSecFrom(now()), keyHex: env.SESSION_KEY });
    return { token: s.token, expires_in: s.expires_in };
  }

  async function createGuestAccount(req, res, b) {
    const limits = config().server.rate_limits;
    if (config().flags.guest_play !== true) fail('VALIDATION', { message: GUEST_PLAY_OFF });
    rateLimited(limiter.hit('accounts-ip', req.ip, limits.login_per_min_ip));
    if (!admitted(admission, req, res, { grant: b.grant })) return;
    rateLimited(limiter.hit('guest-ip-day', req.ip, limits.guest_per_day_ip, DAY_MS));
    const account = await createGuest({ platform: req.rjClient.platform, installId: req.rjClient.install });
    sendOk(res, {
      user: { id: account.user_id, username: account.username, guest: true },
      session: sessionFor(account.user_id),
      credential: account.credential,
    });
  }

  router.post('/accounts', route(async (req, res) => {
    const b = body(req);
    if (b.guest === true) {
      await createGuestAccount(req, res, b);
      return;
    }
    accountLimits(req, b, { limiter, rateLimited, limits: config().server.rate_limits });
    checkFieldMax(b);
    if (!admitted(admission, req, res, { grant: b.grant })) return;

    const account = await withRules(() => createAccount({ username: b.username, email: b.email, password: b.password },
      { platform: req.rjClient.platform, installId: req.rjClient.install }));
    sendOk(res, {
      user: { id: account.user_id, username: account.username, guest: false },
      session: sessionFor(account.user_id),
      credential: account.credential,
    });
  }));
}

module.exports = { registerAccountRoutes, accountLimits, checkFieldMax, withRules };
