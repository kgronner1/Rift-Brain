// The users table: account creation, the two logins, account deletion, and guests (RJ 493).
const crypto = require('crypto');
const { getDB } = require('../db');
const bcrypt = require('bcryptjs');  // Import bcrypt for password hashing
const fs = require('fs').promises;
const path = require('path');
const log = require('../log');
const { issueCredential } = require('../auth/credentials');
const { anonymizeFeedbackForUser } = require('./feedback');

async function createAccessToken() {
  // Generate a salt with a specified number of rounds (cost factor)
  return await bcrypt.genSalt();
}

const RESERVED_USERNAME_RE = /^pilot-?\d+$/i;
const RESERVED_USERNAME = 'That username is reserved.';

// A new account's rules: the three fields, no bad word in the username, not a guest's name (RJ 493), a free
// username, a plausible and free email. Throws an Error whose message is shown to the player. A guest's upgrade
// (POST /v1/me/upgrade) is held to the same rules.
async function checkNewUser(user, db) {
  const requiredFields = ['username', 'email', 'password'];
  for (const field of requiredFields) {
    if (typeof user[field] !== 'string' || user[field] === '') {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Load bad words list
  const filePath = path.join(__dirname, '..', 'bad_words.json');
  const badWordsData = await fs.readFile(filePath, 'utf-8');
  const badWords = JSON.parse(badWordsData).bad_words;

  // Check if username contains any bad word as a standalone token (case-insensitive).
  // This avoids false positives like "Stitch" matching "tit".
  const lowerUsername = user.username.toLowerCase();
  for (const badWord of badWords) {
    const normalizedBadWord = badWord.toLowerCase().trim();
    const escapedBadWord = normalizedBadWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const standaloneWordPattern = new RegExp(`(?:^|[^a-z0-9])${escapedBadWord}(?:$|[^a-z0-9])`, 'i');

    if (standaloneWordPattern.test(lowerUsername)) {
      throw new Error(`Username is not allowed. Please be considerate to the children who are playing this game.`);
    }
  }

  // RJ 493: guests are named Pilot-NNNN; a real account may not look like one.
  if (RESERVED_USERNAME_RE.test(user.username.trim())) {
    throw new Error(RESERVED_USERNAME);
  }

  const [existing] = await db.execute(
    `SELECT user_id FROM users WHERE username = ? LIMIT 1;`,
    [user.username]
  );
  if (existing.length > 0) {
    throw new Error(`This username "${user.username}" is already taken.`);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(user.email)) {
    throw new Error(`Invalid email format: ${user.email}`);
  }

  const [existingEmail] = await db.execute(
    `SELECT user_id FROM users WHERE email = ? LIMIT 1;`,
    [user.email]
  );
  if (existingEmail.length > 0) {
    throw new Error(`This email is already registered.`);
  }
}

// The legacy /create_user: today's account with its plaintext access_token (the legacy database only).
async function createUser(user) {
  const db = getDB();
  await checkNewUser(user, db);

  // Hash the password before storing
  const hashed_password = await bcrypt.hash(user.password, 10);  // Hashing with a salt rounds of 10

  const access_token = await createAccessToken();

  // MySQL query to insert a new user
  const query = `
    INSERT INTO users (username, email, password, access_token, last_login, created_date)
    VALUES (?, ?, ?, ?, NOW(), NOW());
  `;

  // Values to insert
  const values = [
    user.username,
    user.email,
    hashed_password,  // Storing hashed password
    access_token
  ];

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(query, values);

    const newId = result.insertId;
    await connection.execute(`INSERT INTO user_stats (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_accolades (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_accolades_time_earned (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_player_card (user_id) VALUES (?)`, [newId]);

    await connection.commit();
    return { "user": user, "user_id": newId, "access_token": access_token };
  } catch (error) {
    await connection.rollback();
    log.error('Error creating user:', error.message);
    throw error;
  } finally {
    connection.release();
  }
}


async function readUser(user_id) {
  const db = getDB();
  let values = [user_id];
  const [rows] = await db.query('SELECT * FROM users where user = ?', values);
  return rows;
}

async function passiveLoginUser(body) {
  // on open app check the access_token matches the user_id
  const db = getDB(); // Assuming getDB returns the database connection pool or connection object
  const user_id = body.user_id;
  const access_token = body.access_token;

  let user = {};
  let user_stats = {};
  //let user_accolades = {};

  try {

    // Query to fetch the user by user_id and access_token
    const query = `SELECT username, email, last_login, created_date FROM users WHERE user_id = ? && access_token = ?`;
    // Fetch the user from the database
    let [resp] = await db.execute(query, [user_id, access_token]);
    user = resp[0];

    if (!user) {

      throw new Error('No matching user found.');

    }
    else {

      try {

        const queryUpdate = `
          UPDATE users
          SET last_login = NOW()
          WHERE user_id = ?;
        `;

        try {
          // Execute the query
          const [result] = await db.execute(queryUpdate, [user_id]);
        } catch (error) {
          log.warn("Failed to update last login date.", error.message)
        }

        return {"user":user, "user_id":user_id};

      } catch (error) {

        log.error('Error getting stats during passive login:', error.message);
        throw error;

      }
    }

  } catch (error) {
      log.error('Error during passive login:', error.message);
      throw error;
  }

}

// Function to check user login credentials
async function loginUser(body) {

  const db = getDB(); // Assuming getDB returns the database connection pool or connection object
  const user_credential = body.user_credential;
  const password = body.password;
  let user = {};

  try {
    // Query to fetch the user by email
    const query = `SELECT * FROM users WHERE email = ?`;
    // Fetch the user from the database
    let [resp] = await db.execute(query, [user_credential]);
    user = resp[0];

    if (!user) {
      // If no user found with this email
      //throw new Error('No user found with this email');

      try {
          // Query to fetch the user by username
          const query = `SELECT * FROM users WHERE username = ?`;
          [resp] = await db.execute(query, [user_credential]);
          user = resp[0];

          if (!user) {
            throw new Error('No matching user found.');
          }


      } catch (error) {
        log.error('Error during login username:', error.message);
        throw error;
      }

    }

    // Compare the plain-text password with the stored hashed password. A guest (RJ 493) has none: never a match.
    const isPasswordCorrect = typeof user.password === 'string' && typeof password === 'string'
      && await bcrypt.compare(password, user.password);

    if (isPasswordCorrect) {
      // If the password matches

      // update the row with current time for login
      // MySQL query to update
      const query = `
        UPDATE users
        SET last_login = NOW()
        WHERE user_id = ?;
      `;

      let values = [
        user.user_id
      ];

      try {
        // Execute the query
        const [result] = await db.execute(query, values);
      } catch (error) {
        log.warn("Failed to update last login date.", error.message)
      }

      user.password = '';

      return {"user": user, "user_id":user.user_id, "access_token":user.access_token}; // Return the player data (or a session token, etc.)

    } else {
      // If the password doesn't match
      throw new Error('Invalid password');
    }
  } catch (error) {
    // Handle errors
    log.error('Error during login:', error.message);
    throw error;
  }
}

// --- /v1 (RJ 465): accounts without an access_token, signed in by credential and session ---------------------------

// A bcrypt hash to compare against when no user matches, so an unknown name costs what a wrong password costs.
const DUMMY_HASH = bcrypt.hashSync('rift-jumpers-no-such-user', 10);

// A new user's four per-user rows and its first credential (the clear token, once), on the caller's transaction.
async function insertUserRows(connection, userId, { platform, installId }) {
  await connection.execute(`INSERT INTO user_stats (user_id) VALUES (?)`, [userId]);
  await connection.execute(`INSERT INTO user_accolades (user_id) VALUES (?)`, [userId]);
  await connection.execute(`INSERT INTO user_accolades_time_earned (user_id) VALUES (?)`, [userId]);
  await connection.execute(`INSERT INTO user_player_card (user_id) VALUES (?)`, [userId]);
  return issueCredential(connection, { userId, platform, installId });
}

// /v1/accounts: today's rules, then the user, its four per-user rows and its first credential, in one transaction.
// The users table of the new databases has no access_token (migrations/0002). Returns {user_id, username, credential}.
async function createAccount(user, { platform, installId }) {
  const db = getDB();
  await checkNewUser(user, db);
  const hashed_password = await bcrypt.hash(user.password, 10);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO users (username, email, password, last_login, created_date) VALUES (?, ?, ?, NOW(), NOW());`,
      [user.username, user.email, hashed_password]
    );
    const newId = result.insertId;
    const credential = await insertUserRows(connection, newId, { platform, installId });
    await connection.commit();
    return { user_id: newId, username: user.username, credential };
  } catch (error) {
    await connection.rollback();
    // Two sign-ups racing for one name: the UNIQUE key (0002) catches what checkNewUser could not.
    if (error && error.code === 'ER_DUP_ENTRY') throw new Error(takenMessage(error, user.username));
    throw error;
  } finally {
    connection.release();
  }
}

function takenMessage(error, username) {
  return /email/i.test(String(error.message)) ? 'This email is already registered.' : `This username "${username}" is already taken.`;
}

// /v1/session with a login: the user whose email, else username, is `id` and whose password matches, or null.
// A guest (RJ 493: no email, no password) never matches, whatever is typed. Touches last_login. The password hash
// never leaves this function.
async function verifyLogin(id, password) {
  const db = getDB();
  let [rows] = await db.execute(`SELECT user_id, username, password, is_guest FROM users WHERE email = ? LIMIT 1`, [id]);
  if (!rows[0]) [rows] = await db.execute(`SELECT user_id, username, password, is_guest FROM users WHERE username = ? LIMIT 1`, [id]);
  const row = rows[0];
  const real = !!row && typeof row.password === 'string' && !Number(row.is_guest);
  const match = await bcrypt.compare(password, real ? row.password : DUMMY_HASH);
  if (!real || !match) return null;
  await touchLastLogin(row.user_id);
  return { user_id: Number(row.user_id), username: row.username, guest: false };
}

async function touchLastLogin(user_id) {
  try {
    await getDB().execute(`UPDATE users SET last_login = NOW() WHERE user_id = ?`, [user_id]);
  } catch (error) {
    log.warn('Failed to update last login date.', error.message);
  }
}

// --- account deletion (RJ 473) -----------------------------------------------------------------------------------

// Whether the account still exists. A session is stateless and outlives a deleted account by up to an hour, so the
// routes that act for a session's user ask this first. One primary-key read.
async function userExists(userId, db = getDB()) {
  const [rows] = await db.execute('SELECT 1 AS present FROM users WHERE user_id = ? LIMIT 1', [userId]);
  return rows.length > 0;
}

// Which of these user ids still have an account (the internal API's match results drop the rest).
async function existingUserIds(userIds, db = getDB()) {
  if (!userIds.length) return [];
  const [rows] = await db.execute(
    `SELECT user_id FROM users WHERE user_id IN (${userIds.map(() => '?').join(', ')})`,
    userIds,
  );
  return rows.map((r) => Number(r.user_id));
}

// DELETE /v1/me's password check: 'ok', 'wrong', or 'gone' when the account no longer exists. The hash stays here.
async function verifyUserPassword(userId, password) {
  const [rows] = await getDB().execute('SELECT password FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows[0]) return 'gone';
  const real = typeof rows[0].password === 'string';
  const match = await bcrypt.compare(password, real ? rows[0].password : DUMMY_HASH);
  return real && match ? 'ok' : 'wrong';
}

// The session's account for DELETE /v1/me and the upgrade: {user_id, username, guest}, or null when it is gone.
async function findAccount(userId, db = getDB()) {
  const [rows] = await db.execute('SELECT user_id, username, is_guest FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows[0]) return null;
  return { user_id: Number(rows[0].user_id), username: rows[0].username, guest: Number(rows[0].is_guest) === 1 };
}

// The tables that hold a user's rows, in an order the foreign keys allow (user_stats' key does not cascade).
const USER_TABLES = ['user_credentials', 'user_player_card', 'user_accolades_time_earned', 'user_accolades', 'user_stats'];

// A guest (RJ 493) idle for ? days -- three times the same number: no login, no creation and no credential used
// since then (a restore and every hourly session refresh touch last_used_at). NOW() is the database's clock, the one
// that wrote every one of those times.
const IDLE_GUEST = `u.is_guest = 1
  AND (u.last_login IS NULL OR u.last_login < NOW() - INTERVAL ? DAY)
  AND (u.created_date IS NULL OR u.created_date < NOW() - INTERVAL ? DAY)
  AND NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.user_id AND c.last_used_at >= NOW() - INTERVAL ? DAY)`;

// The hard delete, in one transaction: every per-user row and the users row (so every credential, and the
// leaderboard entries with user_stats), and the user's feedback kept but anonymised. Returns false when there was
// no such user. Usable outside a request (db: a pool); the caller logs and releases the user's match seats.
// idleGuestDays (the guest cull, RJ 493): delete only while the user is still a guest idle that long, checked under
// the row lock, so a guest who upgrades or comes back after the cull picked it is kept.
async function deleteUser(userId, { db = getDB(), now = Date.now(), idleGuestDays } = {}) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const guarded = idleGuestDays !== undefined;
    const [rows] = await connection.execute(
      `SELECT u.user_id FROM users u WHERE u.user_id = ?${guarded ? ` AND ${IDLE_GUEST}` : ''} FOR UPDATE`,
      guarded ? [userId, idleGuestDays, idleGuestDays, idleGuestDays] : [userId],
    );
    if (!rows.length) {
      await connection.rollback();
      return false;
    }
    for (const table of USER_TABLES) await connection.execute(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    await connection.execute('DELETE FROM users WHERE user_id = ?', [userId]);
    await anonymizeFeedbackForUser(userId, { db: connection, now });
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// --- guests (RJ 493) ----------------------------------------------------------------------------------------------

// Pilot-NNNN: four random digits, six once a few have collided. The UNIQUE key on username settles a collision.
const GUEST_NAME_TRIES = [4, 4, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6];

// POST /v1/accounts {guest: true}: a users row with is_guest 1, a generated username and no email or password, plus
// the same per-user rows and first credential as createAccount(), in one transaction. Returns {user_id, username,
// credential}. randomInt: crypto.randomInt's signature (tests force collisions).
async function createGuest({ platform, installId }, { randomInt = crypto.randomInt } = {}) {
  const connection = await getDB().getConnection();
  try {
    await connection.beginTransaction();
    let userId = null;
    let username = null;
    for (const digits of GUEST_NAME_TRIES) {
      username = `Pilot-${String(randomInt(0, 10 ** digits)).padStart(digits, '0')}`;
      try {
        const [result] = await connection.execute(
          `INSERT INTO users (username, email, password, is_guest, last_login, created_date) VALUES (?, NULL, NULL, 1, NOW(), NOW())`,
          [username],
        );
        userId = result.insertId;
        break;
      } catch (error) {
        if (!error || error.code !== 'ER_DUP_ENTRY') throw error;
      }
    }
    if (userId === null) throw new Error(`no free guest username after ${GUEST_NAME_TRIES.length} tries`);
    const credential = await insertUserRows(connection, userId, { platform, installId });
    await connection.commit();
    return { user_id: userId, username, credential };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// POST /v1/me/upgrade: the guest's own row gets the username, email and password and stops being a guest; its id,
// credentials and stats stay. checkNewUser's rules apply (its Errors carry the player's message). Returns
// {user_id, username}, or 'gone' when the account no longer exists, or 'not_guest' when it already has a login.
async function upgradeGuest(userId, user) {
  const db = getDB();
  const account = await findAccount(userId, db);
  if (!account) return 'gone';
  if (!account.guest) return 'not_guest';
  await checkNewUser(user, db);
  const hashed = await bcrypt.hash(user.password, 10);
  let result;
  try {
    [result] = await db.execute(
      'UPDATE users SET username = ?, email = ?, password = ?, is_guest = 0 WHERE user_id = ? AND is_guest = 1',
      [user.username, user.email, hashed, userId],
    );
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') throw new Error(takenMessage(error, user.username));
    throw error;
  }
  // Nothing changed: an upgrade or a delete of the same account got there first.
  if (result.affectedRows === 0) return (await findAccount(userId, db)) ? 'not_guest' : 'gone';
  return { user_id: userId, username: user.username };
}

// The cull's batch: guests idle for `days` (IDLE_GUEST), lowest id first, at most `limit`.
async function findIdleGuests({ days, limit }, db = getDB()) {
  const n = Math.max(0, Math.floor(limit));
  if (n === 0) return [];
  const [rows] = await db.execute(
    `SELECT u.user_id FROM users u WHERE ${IDLE_GUEST} ORDER BY u.user_id LIMIT ${n}`,
    [days, days, days],
  );
  return rows.map((r) => Number(r.user_id));
}

module.exports = {
  createAccessToken,
  createUser,
  readUser,
  passiveLoginUser,
  loginUser,
  checkNewUser,
  createAccount,
  verifyLogin,
  touchLastLogin,
  userExists,
  existingUserIds,
  verifyUserPassword,
  findAccount,
  deleteUser,
  createGuest,
  upgradeGuest,
  findIdleGuests,
};
