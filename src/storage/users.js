// The users table: account creation and the two logins.
const { getDB } = require('../db');
const bcrypt = require('bcryptjs');  // Import bcrypt for password hashing
const fs = require('fs').promises;
const path = require('path');

async function createAccessToken() {
  // Generate a salt with a specified number of rounds (cost factor)
  return await bcrypt.genSalt();
}

// accepts user is an object
// returns
async function createUser(user) {
  console.log("createuser Func", user);

  // Validate required fields
  const requiredFields = ['username', 'email', 'password'];

  // test
  // user = {"username": "Dude", "email": "a@a.com", "password": "pass"}

  for (const field of requiredFields) {
    if (user[field] === undefined || user[field] === null) {
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

  // db store the user
  const db = getDB(); // Assuming getDB returns the database connection pool or connection object


  // Check if username already exists
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

  // Check if email already exists
  const [existingEmail] = await db.execute(
    `SELECT user_id FROM users WHERE email = ? LIMIT 1;`,
    [user.email]
  );
  if (existingEmail.length > 0) {
    throw new Error(`This email is already registered.`);
  }

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
    console.log(result);

    const newId = result.insertId;
    await connection.execute(`INSERT INTO user_stats (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_accolades (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_accolades_time_earned (user_id) VALUES (?)`, [newId]);
    await connection.execute(`INSERT INTO user_player_card (user_id) VALUES (?)`, [newId]);

    await connection.commit();
    return { "user": user, "user_id": newId, "access_token": access_token };
  } catch (error) {
    await connection.rollback();
    console.error('Error creating user:', error);
    throw error;
  } finally {
    connection.release();
  }
}


async function readUser(user_id) {
  const db = getDB();
  let values = [user_id];
  const [rows] = await db.query('SELECT * FROM users where user = ?', values);
  console.log(rows);
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
    console.log("user on email", user, resp);

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
          console.log("Failed to update last login date.", error)
        }

        return {"user":user, "user_id":user_id};

      } catch (error) {

        console.error('Error getting stats during passive login:', error.message);
        throw error;

      }
    }

  } catch (error) {
      console.error('Error during passive login:', error.message);
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
    console.log()
    user = resp[0];
    console.log("user on email", user, resp);

    if (!user) {
      // If no user found with this email
      //throw new Error('No user found with this email');

      try {
          // Query to fetch the user by username
          const query = `SELECT * FROM users WHERE username = ?`;
          [resp] = await db.execute(query, [user_credential]);
          user = resp[0];

          console.log("user on username", user, resp);

          if (!user) {
            throw new Error('No matching user found.');
          }


      } catch (error) {
        console.error('Error during login username:', error.message);
        throw error;
      }

    }

    // Compare the plain-text password with the stored hashed password
    const isPasswordCorrect = await bcrypt.compare(password, user.password);

    if (isPasswordCorrect) {
      // If the password matches
      console.log('Login successful');

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
        console.log("Failed to update last login date.", error)
      }

      user.password = '';

      return {"user": user, "user_id":user.user_id, "access_token":user.access_token}; // Return the player data (or a session token, etc.)

    } else {
      // If the password doesn't match
      throw new Error('Invalid password');
    }
  } catch (error) {
    // Handle errors
    console.error('Error during login:', error.message);
    throw error;
  }
}

module.exports = {
  createAccessToken,
  createUser,
  readUser,
  passiveLoginUser,
  loginUser,
};
