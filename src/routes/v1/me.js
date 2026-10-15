'use strict';
// The signed-in player's own data (spec 4.10), every route behind a session:
//   POST   /v1/me/sp-stats/sync      {stats:{...,_last_updated}}      -> {user_stats, ignored_keys}
//   POST   /v1/me/accolades/sync     {accolades:{...,_last_updated}}  -> {user_accolades, ignored_keys}
//   PUT    /v1/me/player-card        {equipped_accolade_key}          -> {equipped_accolade_key}
//   DELETE /v1/me                    {password}                       -> {}   (RJ 473: the account's hard delete)
//
// A session is stateless, so it outlives a deleted account by up to an hour: the three writes first check that the
// account still exists and answer AUTH_INVALID, writing nothing, when it does not. A delete that lands between that
// check and the write still recreates nothing: user_stats and user_player_card have foreign keys to users, and the
// accolade sync only updates.
//
// DELETE /v1/me: VALIDATION (password missing, not a string or too long), then RATE_LIMITED (login_per_min_account,
// per account, in a bucket of its own), then AUTH_INVALID when the account is gone, or with "That password isn't
// right." Not a multiplayer route; no admission. On ok the account's rows are gone (storage deleteUser) and the match
// registry drops its reserved seats and waiting tickets. A player already seated in a match plays on; that match's
// results and accolades for them are ignored (routes/internal).

const { fail, sendOk } = require('../../contract/envelope');
const log = require('../../log');
const storage = require('../../storage');
const { singlePlayerStatsSync, playerAccoladesSync, equipPlayerCard } = storage;
const { PASSWORD_MAX } = require('./session');
const { route, body } = require('./util');

const WRONG_PASSWORD = "That password isn't right.";

// accounts: { userExists, verifyUserPassword, deleteUser } (storage/users.js); tests pass their own.
// match: the registry (match/registry.js), or null.
function registerMeRoutes(router, { requireSession, config, limiter, rateLimited, match = null, accounts = storage }) {
  const liveAccount = route(async (req, res, next) => {
    if (!(await accounts.userExists(req.session.uid))) fail('AUTH_INVALID');
    next();
  });

  router.post('/me/sp-stats/sync', requireSession, liveAccount, route(async (req, res) => {
    const r = await singlePlayerStatsSync({ user_id: req.session.uid, stats: body(req).stats });
    sendOk(res, { user_stats: r.user_stats, ignored_keys: r.ignored_keys });
  }));

  router.post('/me/accolades/sync', requireSession, liveAccount, route(async (req, res) => {
    const r = await playerAccoladesSync({ user_id: req.session.uid, accolades: body(req).accolades });
    sendOk(res, { user_accolades: r.user_accolades, ignored_keys: r.ignored_keys });
  }));

  router.put('/me/player-card', requireSession, liveAccount, route(async (req, res) => {
    const r = await equipPlayerCard(req.session.uid, body(req).equipped_accolade_key);
    sendOk(res, { equipped_accolade_key: r.equipped_accolade_key });
  }));

  router.delete('/me', requireSession, route(async (req, res) => {
    const { password } = body(req);
    if (typeof password !== 'string' || password === '' || password.length > PASSWORD_MAX) {
      fail('VALIDATION', { message: 'Enter your password.' });
    }
    const uid = req.session.uid;
    rateLimited(limiter.hit('delete-account', String(uid), config().server.rate_limits.login_per_min_account));

    const check = await accounts.verifyUserPassword(uid, password);
    if (check === 'gone') fail('AUTH_INVALID');
    if (check !== 'ok') fail('AUTH_INVALID', { message: WRONG_PASSWORD });
    // false: a delete of the same account at the same moment got there first. It is gone either way.
    if (await accounts.deleteUser(uid)) log.info(`[account] user ${uid} deleted`);
    if (match) await match.releasePlayer(uid);
    sendOk(res, {});
  }));
}

module.exports = { registerMeRoutes };
