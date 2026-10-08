'use strict';
// The internal API (spec 4.11): game server -> brain, on 127.0.0.1:<INTERNAL_PORT> only, never proxied. Every call
// carries X-RJ-Lobby: <lobby_id>, X-RJ-Lobby-Key: hex HMAC(LOBBY_MASTER_KEY, lobby_id) and X-RJ-Wire. Because the key
// is derived, a restarted brain verifies a lobby it no longer remembers, and the heartbeat adopts it.
//
//   POST /internal/v1/lobby/heartbeat      {port, wire, fp, state, players:[{user_id,seat}], bots, private_code, pid}
//   POST /internal/v1/lobby/player-joined  {user_id, seat}
//   POST /internal/v1/lobby/player-left    {user_id, seat}
//   POST /internal/v1/match/results        [{user_id, stats}, ...]   only users who took a seat in this lobby
//   POST /internal/v1/match/accolades      {user_id, accolades}       likewise
//   GET  /internal/v1/users/:id/accolades
//   GET  /internal/v1/users/:id/player-card
// Every response is spec 4.2's envelope. A bad or missing lobby key is AUTH_REQUIRED (401). The lobby key is never
// logged.

const crypto = require('crypto');
const express = require('express');
const { fail, sendOk, ApiError } = require('../../contract/envelope');
const { deriveLobbyKey } = require('../../auth/tokens');
const { requestId } = require('../../middleware/requestId');
const { errors } = require('../../middleware/errors');
const { route, isObject, body, requireUserId } = require('../v1/util');
const { LOBBY_ID_RE, MAX_PLAYERS } = require('../../match/registry');
const storage = require('../../storage');

const BODY_LIMIT = '256kb';
const KEY_RE = /^[0-9a-fA-F]{64}$/;

function lobbyAuth(masterKeyHex) {
  return function lobbyAuthMiddleware(req, res, next) {
    const id = String(req.get('X-RJ-Lobby') || '').trim();
    const key = String(req.get('X-RJ-Lobby-Key') || '').trim();
    if (!LOBBY_ID_RE.test(id) || !KEY_RE.test(key)) return next(new ApiError('AUTH_REQUIRED'));
    const expected = Buffer.from(deriveLobbyKey(masterKeyHex, id), 'hex');
    const given = Buffer.from(key, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return next(new ApiError('AUTH_REQUIRED'));
    req.lobbyId = id;
    return next();
  };
}

function answer(res, r) {
  if (r.result === 'ok') return sendOk(res, r.data);
  return fail(r.code, r.opts);
}

// env: {LOBBY_MASTER_KEY}. match: the registry. store: the storage functions (tests inject stand-ins).
function createInternalRouter({ env, match, config = () => ({ messages: {} }), store = storage }) {
  if (!env.LOBBY_MASTER_KEY) throw new Error('/internal/v1 needs LOBBY_MASTER_KEY');
  const router = express.Router();
  router.use(requestId());
  router.use(lobbyAuth(env.LOBBY_MASTER_KEY));
  router.use(express.json({ limit: BODY_LIMIT }));

  router.post('/lobby/heartbeat', route(async (req, res) => {
    answer(res, await match.heartbeat(req.lobbyId, body(req)));
  }));
  router.post('/lobby/player-joined', route(async (req, res) => {
    answer(res, await match.playerJoined(req.lobbyId, body(req)));
  }));
  router.post('/lobby/player-left', route(async (req, res) => {
    answer(res, await match.playerLeft(req.lobbyId, body(req)));
  }));

  router.post('/match/results', route(async (req, res) => {
    if (!Array.isArray(req.body) || req.body.length > 4 * MAX_PLAYERS) fail('VALIDATION', { message: 'Send the match results array.' });
    const accepted = [];
    const ignored = [];
    for (const entry of req.body) {
      const uid = isObject(entry) ? entry.user_id : null;
      if (Number.isInteger(uid) && uid > 0 && isObject(entry.stats) && match.verifiedSeat(req.lobbyId, uid)
        && !accepted.some((e) => e.user_id === uid)) {
        accepted.push({ user_id: uid, stats: entry.stats });
      } else {
        ignored.push(Number.isInteger(uid) ? uid : null);
      }
    }
    const players = accepted.length ? await store.postMatchPlayerStatsUpdate(accepted) : [];
    sendOk(res, { players, ignored_user_ids: ignored });
  }));

  router.post('/match/accolades', route(async (req, res) => {
    const b = body(req);
    if (!Number.isInteger(b.user_id) || b.user_id <= 0) fail('VALIDATION', { message: 'Send {user_id, accolades}.' });
    if (!match.verifiedSeat(req.lobbyId, b.user_id)) fail('VALIDATION', { message: 'That player has no seat in this lobby.', status: 403 });
    const r = await store.playerAccoladesSync({ user_id: b.user_id, accolades: b.accolades });
    sendOk(res, { user_accolades: r.user_accolades, ignored_keys: r.ignored_keys });
  }));

  // User 0 is "nobody": the global earn rates alone, as /v1/users/0/accolades.
  router.get('/users/:id/accolades', route(async (req, res) => {
    const userId = req.params.id === '0' ? 0 : requireUserId(req.params.id);
    sendOk(res, await store.getUserAccolades(userId));
  }));

  router.get('/users/:id/player-card', route(async (req, res) => {
    const card = await store.getPlayerCard(requireUserId(req.params.id));
    if (!card) fail('VALIDATION', { message: "That player doesn't exist.", status: 404 });
    sendOk(res, { user_id: Number(card.user_id), equipped_accolade_key: card.equipped_accolade_key });
  }));

  router.use((req, res, next) => next(new ApiError('VALIDATION', { message: "This request isn't supported.", status: 404 })));
  router.use(errors({ config }));
  return router;
}

module.exports = { createInternalRouter, lobbyAuth };
