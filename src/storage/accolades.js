// The user_accolades and user_accolades_time_earned tables.
const { getDB } = require('../db');
const { loadAccoladeColumns, quoteColumn } = require('./columns');

// +---------------------+------------------+------+-----+---------------------+-------------------------------+
// | Field               | Type             | Null | Key | Default             | Extra                         |
// +---------------------+------------------+------+-----+---------------------+-------------------------------+
// | user_id             | int(10) unsigned | NO   | PRI | NULL                |                               |
// | Beaming             | int(10) unsigned | YES  |     | 0                   |                               |
// | BigAssister         | int(10) unsigned | YES  |     | 0                   |                               |
// | Bully               | int(10) unsigned | YES  |     | 0                   |                               |
// | CleanUpCrew         | int(10) unsigned | YES  |     | 0                   |                               |
// | ColdBlooded         | int(10) unsigned | YES  |     | 0                   |                               |
// | Deflector           | int(10) unsigned | YES  |     | 0                   |                               |
// | EarlyBird           | int(10) unsigned | YES  |     | 0                   |                               |
// | Egalitarian         | int(10) unsigned | YES  |     | 0                   |                               |
// | EtTuBrute           | int(10) unsigned | YES  |     | 0                   |                               |
// | FreezeFrame         | int(10) unsigned | YES  |     | 0                   |                               |
// | Ghost               | int(10) unsigned | YES  |     | 0                   |                               |
// | GreenMachine        | int(10) unsigned | YES  |     | 0                   |                               |
// | InYourFace          | int(10) unsigned | YES  |     | 0                   |                               |
// | IrishGoodbye        | int(10) unsigned | YES  |     | 0                   |                               |
// | Jumpy               | int(10) unsigned | YES  |     | 0                   |                               |
// | LongShot            | int(10) unsigned | YES  |     | 0                   |                               |
// | MachineGun          | int(10) unsigned | YES  |     | 0                   |                               |
// | Nemesis             | int(10) unsigned | YES  |     | 0                   |                               |
// | OneInchPunch        | int(10) unsigned | YES  |     | 0                   |                               |
// | Pacifist            | int(10) unsigned | YES  |     | 0                   |                               |
// | Pyromaniac          | int(10) unsigned | YES  |     | 0                   |                               |
// | Quigley             | int(10) unsigned | YES  |     | 0                   |                               |
// | RiftJumper          | int(10) unsigned | YES  |     | 0                   |                               |
// | Sharpshooter        | int(10) unsigned | YES  |     | 0                   |                               |
// | Sniper              | int(10) unsigned | YES  |     | 0                   |                               |
// | StepInTheArena      | int(10) unsigned | YES  |     | 0                   |                               |
// | StopHittingYourself | int(10) unsigned | YES  |     | 0                   |                               |
// | StudentDriver       | int(10) unsigned | YES  |     | 0                   |                               |
// | TheLateShow         | int(10) unsigned | YES  |     | 0                   |                               |
// | TriggerHappy        | int(10) unsigned | YES  |     | 0                   |                               |
// | Underdog            | int(10) unsigned | YES  |     | 0                   |                               |
// | VarietyShow         | int(10) unsigned | YES  |     | 0                   |                               |
// | Hoarder             | int(10) unsigned | NO   |     | 0                   |                               |
// | Bigwig              | int(10) unsigned | NO   |     | 0                   |                               |
// | MonocleWearer       | int(10) unsigned | NO   |     | 0                   |                               |
// | ScroogeMcDuck       | int(10) unsigned | NO   |     | 0                   |                               |
// | CREAM               | int(10) unsigned | NO   |     | 0                   |                               |
// | TakeaTen            | int(10) unsigned | NO   |     | 0                   |                               |
// | GideonsHammock      | int(10) unsigned | NO   |     | 0                   |                               |
// | AroundtheBlock      | int(10) unsigned | NO   |     | 0                   |                               |
// | Tourist             | int(10) unsigned | NO   |     | 0                   |                               |
// | Nomad               | int(10) unsigned | NO   |     | 0                   |                               |
// | Globetrotter        | int(10) unsigned | NO   |     | 0                   |                               |
// | Grasshopper         | int(10) unsigned | NO   |     | 0                   |                               |
// | ForJoy              | int(10) unsigned | NO   |     | 0                   |                               |
// | SharkJumper         | int(10) unsigned | NO   |     | 0                   |                               |
// | StickyFingers       | int(10) unsigned | NO   |     | 0                   |                               |
// | Ace                 | int(10) unsigned | NO   |     | 0                   |                               |
// | OneSmallStep        | int(10) unsigned | NO   |     | 0                   |                               |
// | HonestDaysWork      | int(10) unsigned | NO   |     | 0                   |                               |
// | AModestIncome       | int(10) unsigned | NO   |     | 0                   |                               |
// | TheBacon            | int(10) unsigned | NO   |     | 0                   |                               |
// | TheLongHaul         | int(10) unsigned | NO   |     | 0                   |                               |
// | Loaded              | int(10) unsigned | NO   |     | 0                   |                               |
// | Entourage           | int(10) unsigned | NO   |     | 0                   |                               |
// | CultFollowing       | int(10) unsigned | NO   |     | 0                   |                               |
// | Streaker            | int(10) unsigned | NO   |     | 0                   |                               |
// | DucksinaRow         | int(10) unsigned | NO   |     | 0                   |                               |
// | Eureka              | int(10) unsigned | NO   |     | 0                   |                               |
// | PrematureFinisher   | int(10) unsigned | NO   |     | 0                   |                               |
// | LeavingAlready      | int(10) unsigned | NO   |     | 0                   |                               |
// | CouldveBeenanEmail  | int(10) unsigned | NO   |     | 0                   |                               |
// | EnduranceAthlete    | int(10) unsigned | NO   |     | 0                   |                               |
// | AscendantAttention  | int(10) unsigned | NO   |     | 0                   |                               |
// | LikeClockwork       | int(10) unsigned | NO   |     | 0                   |                               |
// | KeepitOneHundred    | int(10) unsigned | NO   |     | 0                   |                               |
// | Quicksilver         | int(10) unsigned | NO   |     | 0                   |                               |
// | FrequentFlyer       | int(10) unsigned | NO   |     | 0                   |                               |
// | LudicrousSpeed      | int(10) unsigned | NO   |     | 0                   |                               |
// | FTL                 | int(10) unsigned | NO   |     | 0                   |                               |
// | _last_updated       | timestamp        | NO   |     | current_timestamp() | on update current_timestamp() |
// +---------------------+------------------+------+-----+---------------------+-------------------------------+

async function getUserAccolades(user_id) {

    const db = getDB();

    const queryColumns = `
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_accolades'
          AND COLUMN_NAME != 'user_id' AND COLUMN_NAME != '_last_updated'
    `;
    const queryUser = `SELECT * FROM user_accolades WHERE user_id = ?`;
    const queryTimeEarned = `SELECT * FROM user_accolades_time_earned WHERE user_id = ?`;

    const [[colRows], [userRows], [timeRows]] = await Promise.all([
        db.execute(queryColumns),
        db.execute(queryUser, [user_id]),
        db.execute(queryTimeEarned, [user_id])
    ]);

    const accoladeColumns = colRows.map(row => row.COLUMN_NAME);

    const earnRateSelects = accoladeColumns
        .map(col => `ROUND(SUM(${quoteColumn(col)} > 0) / COUNT(*) * 100, 2) AS ${quoteColumn(col)}`)
        .join(', ');
    const queryEarnRate = `SELECT ${earnRateSelects} FROM user_accolades`;

    const [earnRateRows] = await db.execute(queryEarnRate);

    const user_accolades_raw = userRows[0];
    const earnRate = earnRateRows[0];
    const user_accolades_time_earned = timeRows[0] ?? {};

    const user_accolades = {};
    for (const col of accoladeColumns) {
        const rawTime = user_accolades_time_earned[col];
        user_accolades[col] = {
            earned: user_accolades_raw?.[col] ?? 0,
            earnRate: parseFloat(earnRate[col]),
            timeFirstEarned: rawTime ? Math.floor(new Date(rawTime).getTime() / 1000) : null
        };
    }

    // dont need to return update timestamp
    delete user_accolades.user_id;
    delete user_accolades._last_updated;

    return user_accolades;
}

// Which keys of an accolade sync may be written (spec M3, SQL hardening): a user_accolades column (isValidAccoladeKey's
// allow-list) with a non-negative integer count. Everything else is ignored and reported, never put into SQL.
// `_last_updated` is the sync's own timestamp. Pure over the column set.
function filterAccoladeKeys(accolades, columns) {
  const keys = [];
  const ignored = [];
  if (!accolades || typeof accolades !== 'object' || Array.isArray(accolades)) return { keys, ignored };
  for (const key of Object.keys(accolades)) {
    if (key === '_last_updated') continue;
    const value = accolades[key];
    const allowed = typeof key === 'string' && key.length > 0 && key.length <= 64 && columns.has(key);
    if (allowed && Number.isInteger(value) && value >= 0) keys.push(key);
    else ignored.push(key);
  }
  return { keys, ignored };
}

// The accolade sync: when the client's _last_updated is newer than the row's, its counts replace the database's,
// and an accolade earned for the first time gets its time stamped.
// body: {user_id, accolades: {KEY: COUNT, ..., _last_updated}}. Returns {user_id, user_accolades, ignored_keys}.
async function playerAccoladesSync(body) {

  if (!body.user_id) {
    throw new Error('Missing required field: user_id');
  }

  const db = getDB();
  const user_id = body.user_id;
  const accolades = body.accolades && typeof body.accolades === 'object' && !Array.isArray(body.accolades) ? body.accolades : {};
  const columns = await loadAccoladeColumns();
  const { keys: updateKeys, ignored: ignored_keys } = filterAccoladeKeys(accolades, columns);
  const lastUpdated = Number(accolades._last_updated);

  if (Number.isFinite(lastUpdated) && lastUpdated > 0 && updateKeys.length > 0) {

    const [staleRows] = await db.execute(
      `SELECT user_id FROM user_accolades WHERE user_id = ? AND UNIX_TIMESTAMP(_last_updated) < ?;`,
      [user_id, lastUpdated]
    );

    if (staleRows.length > 0) {

      const fields = updateKeys.map(key => `${quoteColumn(key)} = ?`).join(', ');
      const values = updateKeys.map(key => accolades[key]);

      // An accolade newly earned: stamp its first-earned time if it has none.
      const potentialFirstEarnKeys = updateKeys.filter(key => accolades[key] > 0);
      if (potentialFirstEarnKeys.length > 0) {
        const [timeRows] = await db.execute(
          `SELECT * FROM user_accolades_time_earned WHERE user_id = ?`,
          [user_id]
        );
        if (timeRows.length > 0) {
          const timeRow = timeRows[0];
          const firstTimeKeys = potentialFirstEarnKeys.filter(key => timeRow[key] === null);
          if (firstTimeKeys.length > 0) {
            const timeFields = firstTimeKeys.map(key => `${quoteColumn(key)} = NOW()`).join(', ');
            await db.execute(
              `UPDATE user_accolades_time_earned SET ${timeFields} WHERE user_id = ?`,
              [user_id]
            );
          }
        }
      }

      values.push(user_id);
      await db.execute(
        `UPDATE user_accolades SET ${fields}, _last_updated = NOW() WHERE user_id = ?;`,
        values
      );

    }

  }

  const resp = await getUserAccolades(user_id);

  if (!resp) {
    throw new Error('No matching user accolades found.');
  }

  return { "user_id": user_id, "user_accolades": resp, ignored_keys };

}

module.exports = {
  getUserAccolades,
  playerAccoladesSync,
  filterAccoladeKeys,
};
