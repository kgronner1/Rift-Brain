'use strict';
// The signed-in player's own data (spec 4.10), every route behind a session:
//   POST /v1/me/sp-stats/sync      {stats:{...,_last_updated}}      -> {user_stats, ignored_keys}
//   POST /v1/me/accolades/sync     {accolades:{...,_last_updated}}  -> {user_accolades, ignored_keys}
//   PUT  /v1/me/player-card        {equipped_accolade_key}          -> {equipped_accolade_key}

const { sendOk } = require('../../contract/envelope');
const { singlePlayerStatsSync, playerAccoladesSync, equipPlayerCard } = require('../../storage');
const { route, body } = require('./util');

function registerMeRoutes(router, { requireSession }) {
  router.post('/me/sp-stats/sync', requireSession, route(async (req, res) => {
    const r = await singlePlayerStatsSync({ user_id: req.session.uid, stats: body(req).stats });
    sendOk(res, { user_stats: r.user_stats, ignored_keys: r.ignored_keys });
  }));

  router.post('/me/accolades/sync', requireSession, route(async (req, res) => {
    const r = await playerAccoladesSync({ user_id: req.session.uid, accolades: body(req).accolades });
    sendOk(res, { user_accolades: r.user_accolades, ignored_keys: r.ignored_keys });
  }));

  router.put('/me/player-card', requireSession, route(async (req, res) => {
    const r = await equipPlayerCard(req.session.uid, body(req).equipped_accolade_key);
    sendOk(res, { equipped_accolade_key: r.equipped_accolade_key });
  }));
}

module.exports = { registerMeRoutes };
