'use strict';
// The signed-in player's own data (spec 4.10), every route behind a session:
//   POST   /v1/me/sp-stats/sync      {stats:{...,_last_updated}}      -> {user_stats, ignored_keys}
//   POST   /v1/me/accolades/sync     {accolades:{...,_last_updated}}  -> {user_accolades, ignored_keys}
//   PUT    /v1/me/player-card        {equipped_accolade_key}          -> {equipped_accolade_key}
//   DELETE /v1/me                    {password}                       -> {}   (RJ 473: the account's hard delete)
//   POST   /v1/me/upgrade            {username, email, password}      -> {user:{id, username, guest:false}}   (RJ 493)
//   POST   /v1/me/payload/credit     {entries:[{ref, source, amount}]} -> {balance, earned_alltime, entries}  (RJ 587)
//
// A session is stateless, so it outlives a deleted account by up to an hour: the writes (the two syncs, the player
// card and, RJ 587, the payload credit) first check that the account still exists and answer AUTH_INVALID, writing
// nothing, when it does not. A delete that lands between that check and the write still recreates nothing: user_stats,
// user_player_card and payload_ledger have foreign keys to users, and the accolade sync only updates.
//
// PUT /v1/me/player-card: an accolade the player has earned, or '' for none. Anything else is VALIDATION and writes
// nothing, so the accolade already equipped stands (RJ 547).
//
// DELETE /v1/me: RATE_LIMITED (login_per_min_account, per account, in a bucket of its own), then AUTH_INVALID when the
// account is gone; then, for an account with a login, VALIDATION (password missing, not a string or too long) and
// AUTH_INVALID "That password isn't right." A guest (RJ 493) has no password: whatever is sent is ignored. Not a
// multiplayer route; no admission. On ok the account's rows are gone (storage deleteUser) and the match registry drops
// its reserved seats and waiting tickets. A player already seated in a match plays on; that match's results and
// accolades for them are ignored (routes/internal).
//
// POST /v1/me/upgrade (RJ 493): a guest gets a login on the same row (same id, credentials, session and stats). The
// limits and the rules of POST /v1/accounts (accounts.js; checkNewUser, the reserved Pilot-NNNN names included), no
// admission. AUTH_INVALID when the account is gone; VALIDATION "This account already has a login." for a non-guest.
//
// POST /v1/me/payload/credit (RJ 587): the player's payload entries, 0..32 (an empty array reads the balance), applied
// in one transaction in the order sent (storage/payloadLedger.js; the rules are contract/payload.js). Not an array,
// over 32 or a non-object entry: VALIDATION, checked before any database work, and nothing applied. Each entry's
// answer is applied (credited), duplicate, rejected (reason) or deferred, in order. Like the syncs: no rate limit, no
// admission, and AUTH_INVALID for a gone account.

const { fail, sendOk } = require('../../contract/envelope');
const log = require('../../log');
const storage = require('../../storage');
const { singlePlayerStatsSync, playerAccoladesSync, equipPlayerCard } = storage;
const { PASSWORD_MAX } = require('./session');
const { accountLimits, checkFieldMax, withRules } = require('./accounts');
const { route, body } = require('./util');
const { checkEntries } = require('../../contract/payload');

const WRONG_PASSWORD = "That password isn't right.";
const HAS_LOGIN = 'This account already has a login.';

// accounts: { userExists, findAccount, verifyUserPassword, deleteUser, upgradeGuest } (storage/users.js); tests pass
// their own.
// match: the registry (match/registry.js), or null.
// payload: { applyPayloadEntries } (storage/payloadLedger.js); tests pass their own.
function registerMeRoutes(router, { requireSession, config, limiter, rateLimited, match = null, accounts = storage, payload = storage }) {
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

  const payloadShape = (req, res, next) => {
    const bad = checkEntries(body(req).entries);
    if (bad) fail('VALIDATION', { message: bad });
    next();
  };

  router.post('/me/payload/credit', requireSession, payloadShape, liveAccount, route(async (req, res) => {
    sendOk(res, await payload.applyPayloadEntries(req.session.uid, body(req).entries, { from: 'client' }));
  }));

  router.put('/me/player-card', requireSession, liveAccount, route(async (req, res) => {
    const r = await equipPlayerCard(req.session.uid, body(req).equipped_accolade_key);
    if (!r) fail('VALIDATION', { message: "You haven't earned that accolade yet." });
    sendOk(res, { equipped_accolade_key: r.equipped_accolade_key });
  }));

  router.delete('/me', requireSession, route(async (req, res) => {
    const { password } = body(req);
    const uid = req.session.uid;
    rateLimited(limiter.hit('delete-account', String(uid), config().server.rate_limits.login_per_min_account));

    const account = await accounts.findAccount(uid);
    if (!account) fail('AUTH_INVALID');
    if (!account.guest) {
      if (typeof password !== 'string' || password === '' || password.length > PASSWORD_MAX) {
        fail('VALIDATION', { message: 'Enter your password.' });
      }
      const check = await accounts.verifyUserPassword(uid, password);
      if (check === 'gone') fail('AUTH_INVALID');
      if (check !== 'ok') fail('AUTH_INVALID', { message: WRONG_PASSWORD });
    }
    // false: a delete of the same account at the same moment got there first. It is gone either way.
    if (await accounts.deleteUser(uid)) log.info(`[account] user ${uid} deleted`);
    if (match) await match.releasePlayer(uid);
    sendOk(res, {});
  }));

  router.post('/me/upgrade', requireSession, liveAccount, route(async (req, res) => {
    const b = body(req);
    accountLimits(req, b, { limiter, rateLimited, limits: config().server.rate_limits });
    checkFieldMax(b);
    const r = await withRules(() => accounts.upgradeGuest(req.session.uid, { username: b.username, email: b.email, password: b.password }));
    if (r === 'gone') fail('AUTH_INVALID');
    if (r === 'not_guest') fail('VALIDATION', { message: HAS_LOGIN });
    sendOk(res, { user: { id: r.user_id, username: r.username, guest: false } });
  }));
}

module.exports = { registerMeRoutes };
