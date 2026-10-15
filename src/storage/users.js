// The users table: account creation, the two logins and account deletion.
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

// A new account's rules (today's, unchanged): the three fields, no bad word in the username, a free username, a
// plausible and free email. Throws an Error whose message is shown to the player.
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

    // Compare the plain-text password with the stored hashed password
    const isPasswordCorrect = await bcrypt.compare(password, user.password);

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
    await connection.execute(`INSERT INTO user_stats (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_accolades (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_accolades_time_earned (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_player_card (user_id) VALUES (?)`, [newId]);
    const credential = await issueCredential(connection, { userId: newId, platform, installId });
    await connection.commit();
    return { user_id: newId, username: user.username, credential };
  } catch (error) {
    await connection.rollback();
    // Two sign-ups racing for one name: the UNIQUE key (0002) catches what checkNewUser could not.
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new Error(/email/i.test(String(error.message)) ? 'This email is already registered.' : `This username "${user.username}" is already taken.`);
    }
    throw error;
  } finally {
    connection.release();
  }
}

// /v1/session with a login: the user whose email, else username, is `id` and whose password matches, or null.
// Touches last_login. The password hash never leaves this function.
async function verifyLogin(id, password) {
  const db = getDB();
  let [rows] = await db.execute(`SELECT user_id, username, password FROM users WHERE email = ? LIMIT 1`, [id]);
  if (!rows[0]) [rows] = await db.execute(`SELECT user_id, username, password FROM users WHERE username = ? LIMIT 1`, [id]);
  const row = rows[0];
  const hash = row && typeof row.password === 'string' ? row.password : DUMMY_HASH;
  const match = await bcrypt.compare(password, hash);
  if (!row || !match) return null;
  await touchLastLogin(row.user_id);
  return { user_id: Number(row.user_id), username: row.username };
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
  const hash = typeof rows[0].password === 'string' ? rows[0].password : DUMMY_HASH;
  return (await bcrypt.compare(password, hash)) ? 'ok' : 'wrong';
}

// The tables that hold a user's rows, in an order the foreign keys allow (user_stats' key does not cascade).
const USER_TABLES = ['user_credentials', 'user_player_card', 'user_accolades_time_earned', 'user_accolades', 'user_stats'];

// The hard delete, in one transaction: every per-user row and the users row (so every credential, and the
// leaderboard entries with user_stats), and the user's feedback kept but anonymised. Returns false when there was
// no such user. Usable outside a request (db: a pool); the caller logs and releases the user's match seats.
async function deleteUser(userId, { db = getDB(), now = Date.now() } = {}) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT user_id FROM users WHERE user_id = ? FOR UPDATE', [userId]);
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
  deleteUser,
};
