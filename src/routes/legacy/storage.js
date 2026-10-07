// Today's account, stats, accolade and player-card routes, unchanged in path and shape.
// /v1/* (M3) and /internal/v1/* (M4) replace them; these go at cutover.

const fs = require('fs').promises;
const path = require('path');
const { getDB } = require('../../db');
const {
  createUser,
  loginUser,
  passiveLoginUser,
  postMatchPlayerStatsUpdate,
  singlePlayerStatsSync,
  playerAccoladesSync,
  getUserStatsColumns,
  formatUserStatsColumnName,
  requireUserStatsField,
  getUserAccolades,
  getPlayerCard,
  getPlayerCards,
  setPlayerCard,
} = require('../../storage');

// // // // // // // // // // // // // storage response api // // // // // // // // // // // // //

function registerStorageRoutes(app) {

  //// login ////

  app.post('/create_user', async function (req, res) {
    console.log("create_user endpoint hit:", req.body);
    //console.log("reqAAA:", req);
  
    try {
      const result = await createUser(req.body); // Use req.body for POST data
      res.status(200).json({
        success: true,
        message: "User created successfully",
        data: result
      });
    } catch (error) {
      console.error("User creation failed:", error.message);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  });

  app.post('/login_user', async function (req, res) {

    console.log("login_user endpoint hit:", req.body);
    //console.log("reqAAA:", req);
  
    try {
      const result = await loginUser(req.body); // Use req.body for POST data
      res.status(200).json({
        success: true,
        message: "User logged in successfully",
        data: result
      });
    } catch (error) {
      console.error("User login failed:", error.message);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }

  });

  app.post('/passive_login_user', async function (req, res) {

    console.log("passive_login_user endpoint hit:", req.body);
    //console.log("reqAAA:", req);
  
    try {
      const result = await passiveLoginUser(req.body); // Use req.body for POST data
      res.status(200).json({
        success: true,
        message: "Passive user logged in successfully",
        data: {"result": result}
      });
    } catch (error) {
      console.error("Pasive user login failed:", error.message);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }

  });

  app.post('/app_version_compatibility', async function (req, res) {

    const filePath = path.join(__dirname, '..', '..', 'app_versions.json');
    const app_versions = await fs.readFile(filePath, 'utf-8');

    res.status(200).json({
      success: true,
      message: "",
      data: app_versions
    });

  })

  //// login ////

  //// stats ////

  app.post('/post_match_player_stats_update', async function (req, res) {

    console.log("post_match_player_stats_update endpoint hit:", req.body);

    try {
      let response = await postMatchPlayerStatsUpdate(req.body);
      res.status(200).json({
        success: true,
        message: "Updated players' stats successfully",
        data: response
      });
    } catch (error) {
      console.error("Update players' stats failed:", error.message);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }

  });

  app.post('/single_player_stats_sync', async function (req, res) {

    console.log("single_player_stats_sync endpoint hit:", req.body);

    try {
      let response = await singlePlayerStatsSync(req.body);
      res.status(200).json({
        success: true,
        message: "Single player stats synced successfully",
        data: response
      });
    } catch (error) {
      console.error("Single player stats syncs failed:", error.message);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }

  });

  app.post('/player_accolades_sync', async function (req, res) {

    console.log("play_accolades_sync endpoint hit:", req.body);

    try {
      let response = await playerAccoladesSync(req.body);
      res.status(200).json({
        success: true,
        message: "Player accolades synced successfully",
        data: response
      });
    } catch (error) {
      console.error("Player accolades syncs failed:", error.message);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }

  });

  app.post('/user_stats_columns', async function (req, res) {

    try {
      const columns = await getUserStatsColumns();
      const labels = {};
      for (const column of columns) {
        labels[column] = formatUserStatsColumnName(column);
      }
      res.status(200).json({ success: true, message: "", data: columns, labels });
    } catch (error) {
      console.error("User stats columns fetch failed:", error.message);
      res.status(400).json({ success: false, message: error.message });
    }

  });

  app.post('/leaderboard_top_list', async function (req, res) {

    try {
      const field = await requireUserStatsField(req.body.field);
      let limit = Number(req.body.limit);
      if (!limit) {
        limit = 25;
      }
      let user_id = null;
      if (req.body.user_id !== undefined && req.body.user_id !== null && req.body.user_id !== '') {
        user_id = Number(req.body.user_id);
        if (!Number.isInteger(user_id)) throw new Error('Invalid user_id');
      }
      const db = getDB();
      const [rows] = await db.execute(
        `SELECT us.user_id, u.username, us.${field} AS score
         FROM user_stats us
         JOIN users u ON u.user_id = us.user_id
         ORDER BY us.${field} DESC
         LIMIT ?;`, [limit]
      );
      let lastScore = null;
      let lastRank = 0;
      const list = rows.map((row, index) => {
        const position = index + 1;
        if (lastScore === null || row.score !== lastScore) {
          lastRank = position;
          lastScore = row.score;
        }
        return {
          ...row,
          position,
          rank: lastRank
        };
      });
      let user = null;
      if (user_id !== null) {
        const [userRows] = await db.execute(
          `SELECT us.user_id, u.username, us.${field} AS score,
                  (SELECT COUNT(*) + 1
                   FROM user_stats us2
                   WHERE us2.${field} > us.${field}) AS rank
           FROM user_stats us
           JOIN users u ON u.user_id = us.user_id
           WHERE us.user_id = ?
           LIMIT 1;`, [user_id]
        );
        user = userRows[0] || null;
      }
      res.status(200).json({ success: true, message: "", data: { list, user } });
    } catch (error) {
      console.error("Leaderboard fetch failed:", error.message);
      res.status(400).json({ success: false, message: error.message });
    }

  });

  app.post('/user_single_stat', async function (req, res) {

    try {
      const field = await requireUserStatsField(req.body.field);
      const user_id = Number(req.body.user_id);
      if (!Number.isInteger(user_id)) throw new Error('Invalid user_id');
      const db = getDB();
      const [rows] = await db.execute(
        `SELECT user_id, ${field} AS score FROM user_stats WHERE user_id = ? LIMIT 1;`,
        [user_id]
      );
      res.status(200).json({ success: true, message: "", data: rows[0] || null });
    } catch (error) {
      console.error("User single stat fetch failed:", error.message);
      res.status(400).json({ success: false, message: error.message });
    }

  });

  app.post('/user_all_stats', async function (req, res) {

    try {
      const user_id = Number(req.body.user_id);
      if (!Number.isInteger(user_id)) throw new Error('Invalid user_id');
      const db = getDB();
      const [rows] = await db.execute(
        `SELECT * FROM user_stats WHERE user_id = ? LIMIT 1;`,
        [user_id]
      );

      // dont need to send this
      delete rows[0]._last_updated;

      res.status(200).json({ success: true, message: "", data: rows[0] || null });
    } catch (error) {
      console.error("User all stats fetch failed:", error.message);
      res.status(400).json({ success: false, message: error.message });
    }

  });


  app.post('/user_all_accolades', async function (req, res) {

    try {
      const user_id = Number(req.body.user_id);
      if (!Number.isInteger(user_id)) throw new Error('Invalid user_id');

      let resp = await getUserAccolades(user_id);
      // {"ACCOLADE_KEY": {"earnRate":90, "earned":4}, "ACCOLADE_KEY_2": {"earnRate":90, "earned":4}}

      res.status(200).json({ success: true, message: "", data: resp || null });
    } catch (error) {
      console.error("User all accolades fetch failed:", error.message);
      res.status(400).json({ success: false, message: error.message });
    }

  });

  //// stats ////

  //// player card ////

  // Server-to-server only — not called directly by clients.
  app.get('/player_card', async function (req, res) {
    try {
      const user_id = Number(req.query.user_id);
      if (!Number.isInteger(user_id) || user_id <= 0) throw new Error('Invalid user_id');
      const card = await getPlayerCard(user_id);
      if (!card) throw new Error('User not found');
      res.status(200).json({ success: true, message: '', data: card });
    } catch (error) {
      console.error('GET /player_card failed:', error.message);
      res.status(400).json({ success: false, message: error.message });
    }
  });

  // Batch version — retained for admin/analytics contexts; not used in the lobby flow.
  app.get('/player_cards', async function (req, res) {
    try {
      const raw = req.query.user_ids;
      if (!raw) throw new Error('Missing user_ids');
      const user_ids = String(raw).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (user_ids.length === 0) throw new Error('No valid user_ids');
      const cards = await getPlayerCards(user_ids);
      res.status(200).json({ success: true, message: '', data: cards });
    } catch (error) {
      console.error('GET /player_cards failed:', error.message);
      res.status(400).json({ success: false, message: error.message });
    }
  });

  // Called by the authenticated player (client -> backend) to equip an accolade.
  app.put('/player_card', async function (req, res) {
    try {
      const user_id = Number(req.body.user_id);
      if (!Number.isInteger(user_id) || user_id <= 0) throw new Error('Invalid user_id');
      const access_token = req.body.access_token;
      if (!access_token) throw new Error('Missing access_token');
      const equipped_accolade_key = req.body.equipped_accolade_key ?? '';
      const result = await setPlayerCard(user_id, access_token, equipped_accolade_key);
      res.status(200).json({ success: true, message: '', data: result });
    } catch (error) {
      if (error.message === 'Unauthorized') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      console.error('PUT /player_card failed:', error.message);
      res.status(400).json({ success: false, message: error.message });
    }
  });

  //// player card ////

} // registerStorageRoutes

module.exports = { registerStorageRoutes };
