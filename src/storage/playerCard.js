// The user_player_card table.
const { getDB } = require('../db');
const { isValidAccoladeKey, quoteColumn } = require('./columns');

async function getPlayerCard(user_id) {
  const db = getDB();
  // LEFT JOIN so a missing card row degrades to defaults instead of erroring.
  const [rows] = await db.execute(
    `SELECT u.user_id,
            COALESCE(pc.equipped_accolade_key, '') AS equipped_accolade_key
     FROM users u
     LEFT JOIN user_player_card pc ON pc.user_id = u.user_id
     WHERE u.user_id = ?
     LIMIT 1;`,
    [user_id]
  );
  if (!rows[0]) return null;

  let equipped = rows[0].equipped_accolade_key;

  // Read-time validation: if the key is no longer in the allow-list or the player's
  // earn count is 0, return '' so stale/corrected data never stays displayed.
  if (equipped) {
    const valid = await isValidAccoladeKey(equipped);
    if (!valid) {
      equipped = '';
    } else {
      const [earnRows] = await db.execute(
        `SELECT ${quoteColumn(equipped)} AS cnt FROM user_accolades WHERE user_id = ? LIMIT 1;`,
        [user_id]
      );
      if (!earnRows[0] || earnRows[0].cnt === 0) {
        equipped = '';
      }
    }
  }

  return { user_id: rows[0].user_id, equipped_accolade_key: equipped };
}

async function getPlayerCards(user_ids) {
  const results = await Promise.all(user_ids.map(id => getPlayerCard(id)));
  return results.filter(r => r !== null);
}

// The legacy route's set: today's inline access_token check, then equipPlayerCard().
async function setPlayerCard(user_id, access_token, equipped_accolade_key) {
  const db = getDB();
  const [authRows] = await db.execute(
    `SELECT user_id FROM users WHERE user_id = ? AND access_token = ? LIMIT 1;`,
    [user_id, access_token]
  );
  if (!authRows[0]) throw new Error('Unauthorized');
  return equipPlayerCard(user_id, equipped_accolade_key);
}

// Equips an accolade the player has earned. A key that is not an accolade, or one not earned, equips nothing ('').
// The caller has already established who user_id is (the session on /v1, the access_token on the legacy route).
async function equipPlayerCard(user_id, equipped_accolade_key) {
  const db = getDB();
  let key = '';
  if (typeof equipped_accolade_key === 'string' && equipped_accolade_key !== '') {
    const valid = await isValidAccoladeKey(equipped_accolade_key);
    if (valid) {
      const [earnRows] = await db.execute(
        `SELECT ${quoteColumn(equipped_accolade_key)} AS cnt FROM user_accolades WHERE user_id = ? LIMIT 1;`,
        [user_id]
      );
      if (earnRows[0] && earnRows[0].cnt > 0) {
        key = equipped_accolade_key;
      }
    }
  }

  await db.execute(
    `INSERT INTO user_player_card (user_id, equipped_accolade_key)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE equipped_accolade_key = ?;`,
    [user_id, key, key]
  );

  return { user_id, equipped_accolade_key: key };
}

module.exports = {
  getPlayerCard,
  getPlayerCards,
  setPlayerCard,
  equipPlayerCard,
};
