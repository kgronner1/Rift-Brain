'use strict';
// POST /v1/feedback (RJ 488; Wobble Planet specs/player-feedback.md, "The contract"): a player's note, signed in or
// not. Neither locked nor multiplayer: gates 1-3 apply (clientHeaders), maintenance only with scope app.
//
//   body  {id, message, tags?, written_at?, context?}   cleaned by feedback/entry.js
//   ok    {id, received_at}                             a repeat id answers ok with the stored received_at, changing nothing
//
// Who sent it: a valid bearer -> its user (and their username now); no bearer -> anonymous, keeping X-RJ-Install only
// when it is a UUID; a bad or expired bearer -> AUTH_REQUIRED / AUTH_EXPIRED (optionalSession). A session whose
// account no longer exists is stored as anonymous.
// Limits, after the input checks: feedback_per_min_ip, then feedback_per_day_ip (server.rate_limits).
// The brain never reads flags.feedback: that flag only hides the client's buttons.

const { sendOk } = require('../../contract/envelope');
const { DAY_MS } = require('../../middleware/rateLimit');
const { optionalSession } = require('../../middleware/auth');
const { cleanEntry, isUuid } = require('../../feedback/entry');
const storage = require('../../storage/feedback');
const { route } = require('./util');

const INT_MAX = 2147483647;

// store: { insertFeedback(row), findFeedbackUser(uid) } (storage/feedback.js); tests pass their own.
function registerFeedbackRoutes(router, { env, config, now, limiter, rateLimited, store = storage }) {
  const session = optionalSession({ keyHex: env.SESSION_KEY, serverEnv: env.ENV, now });

  router.post('/feedback', session, route(async (req, res) => {
    const entry = cleanEntry(req.body);
    const limits = config().server.rate_limits;
    rateLimited(limiter.hit('feedback-ip', req.ip, limits.feedback_per_min_ip));
    rateLimited(limiter.hit('feedback-ip-day', req.ip, limits.feedback_per_day_ip, DAY_MS));

    let user = null;
    if (req.session) user = await store.findFeedbackUser(req.session.uid);
    const client = req.rjClient;
    const r = await store.insertFeedback({
      ...entry,
      received_ms: now(),
      user_id: user ? user.user_id : null,
      username: user ? String(user.username).slice(0, 64) : null,
      install_id: isUuid(client.install) ? client.install.toLowerCase() : null,
      ip: req.ip ? String(req.ip).slice(0, 45) : null,
      build: client.build > 0 && client.build <= INT_MAX ? client.build : null,
      platform: client.platform ? client.platform.slice(0, 16) : null,
      env: env.ENV,
    });
    sendOk(res, { id: entry.id, received_at: r.received_at });
  }));
}

module.exports = { registerFeedbackRoutes };
