'use strict';
// Public reads (spec 4.10), no session:
//   GET /v1/users/:id/stats         -> the stats row
//   GET /v1/users/:id/accolades     -> the accolades map
//   GET /v1/users/:id/player-card   -> {user_id, equipped_accolade_key}
//   GET /v1/stats/columns           -> {columns, labels}
//   GET /v1/leaderboards/:field     ?limit= (1..100, default 25) &user_id=  -> {list, user}

const { fail, sendOk } = require('../../contract/envelope');
const { getDB } = require('../../db');
const {
  getUserStatsColumns, formatUserStatsColumnName, loadUserStatsColumns, quoteColumn, getUserAccolades, getPlayerCard,
} = require('../../storage');
const { route, requireUserId, parseUserId } = require('./util');

const LIMIT_DEFAULT = 25;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
// Leaderboards rank the stat columns, never the row's own bookkeeping.
const NOT_RANKED = new Set(['user_id', '_last_updated']);

function clampLimit(raw) {
  if (raw === undefined || raw === '') return LIMIT_DEFAULT;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, n));
}

function rankList(rows) {
  let lastScore = null;
  let lastRank = 0;
  return rows.map((row, index) => {
    const position = index + 1;
    if (lastScore === null || row.score !== lastScore) {
      lastRank = position;
      lastScore = row.score;
    }
    return { ...row, position, rank: lastRank };
  });
}

function registerUserRoutes(router) {
  router.get('/users/:id/stats', route(async (req, res) => {
    const userId = requireUserId(req.params.id);
    const [rows] = await getDB().execute('SELECT * FROM user_stats WHERE user_id = ? LIMIT 1', [userId]);
    if (!rows[0]) fail('VALIDATION', { message: "That player doesn't exist.", status: 404 });
    delete rows[0]._last_updated;
    sendOk(res, rows[0]);
  }));

  router.get('/users/:id/accolades', route(async (req, res) => {
    const userId = requireUserId(req.params.id);
    sendOk(res, await getUserAccolades(userId));
  }));

  router.get('/users/:id/player-card', route(async (req, res) => {
    const userId = requireUserId(req.params.id);
    const card = await getPlayerCard(userId);
    if (!card) fail('VALIDATION', { message: "That player doesn't exist.", status: 404 });
    sendOk(res, { user_id: Number(card.user_id), equipped_accolade_key: card.equipped_accolade_key });
  }));

  router.get('/stats/columns', route(async (req, res) => {
    const columns = await getUserStatsColumns();
    const labels = {};
    for (const column of columns) labels[column] = formatUserStatsColumnName(column);
    sendOk(res, { columns, labels });
  }));

  router.get('/leaderboards/:field', route(async (req, res) => {
    const field = req.params.field;
    const { set } = await loadUserStatsColumns();
    if (!set.has(field) || NOT_RANKED.has(field)) fail('VALIDATION', { message: "That leaderboard doesn't exist." });
    const limit = clampLimit(req.query.limit);
    let userId = null;
    if (req.query.user_id !== undefined && req.query.user_id !== '') {
      userId = parseUserId(req.query.user_id);
      if (userId === null) fail('VALIDATION', { message: "That player id isn't valid." });
    }
    const col = quoteColumn(field);
    const db = getDB();
    // limit is an integer in 1..100, so it is written into the statement (LIMIT ? is not portable across servers).
    const [rows] = await db.execute(
      `SELECT us.user_id, u.username, us.${col} AS score
       FROM user_stats us JOIN users u ON u.user_id = us.user_id
       ORDER BY us.${col} DESC, us.user_id ASC
       LIMIT ${limit}`,
    );
    let user = null;
    if (userId !== null) {
      const [userRows] = await db.execute(
        `SELECT us.user_id, u.username, us.${col} AS score,
                (SELECT COUNT(*) + 1 FROM user_stats us2 WHERE us2.${col} > us.${col}) AS \`rank\`
         FROM user_stats us JOIN users u ON u.user_id = us.user_id
         WHERE us.user_id = ? LIMIT 1`,
        [userId],
      );
      user = userRows[0] || null;
      if (user) user.rank = Number(user.rank);
    }
    sendOk(res, { list: rankList(rows), user });
  }));
}

module.exports = { registerUserRoutes, clampLimit, rankList };
