// db import
const { getDB } = require('./db');
const bcrypt = require('bcryptjs');  // Import bcrypt for password hashing

// // // // // // // // USER STORAGE FUNCTIONS // // // // // // // //

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
  const badWordsData = await fs.readFile('./bad_words.json', 'utf-8');
  const badWords = JSON.parse(badWordsData).bad_words;

  // Check if username contains any bad word (case-insensitive)
  const lowerUsername = user.username.toLowerCase();
  for (const badWord of badWords) {
    if (lowerUsername.includes(badWord.toLowerCase())) {
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

  try {
    // Execute the query
    const [result] = await db.execute(query, values);
    
    // Log the result (optional)
    console.log(result);

    // create user_stats insert
    const user_stats_query = `
      INSERT INTO user_stats (user_id) VALUES (?)
    `;

    const user_stats_values = [
      result.insertId
    ];

    const [user_stats_result] = await db.execute(user_stats_query, user_stats_values);

    // Return the user_id (assuming auto-increment)
    return {"user_id":result.insertId, "access_token": access_token}; // The ID of the newly created user
  } catch (error) {
    // Handle any errors
    console.error('Error creating user:', error);
    throw error;
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

        const query = `SELECT * FROM user_stats WHERE user_id = ?`;
        // Fetch the user from the database
        let [resp] = await db.execute(query, [user_id]);
        user_stats = resp[0];


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

        return {"user":user, "user_stats":user_stats};

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

      return {"user_id":user.user_id, "access_token":user.access_token}; // Return the player data (or a session token, etc.)
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

// // // // // // // // GAME STORAGE FUNCTIONS // // // // // // // //

function prepareUpdatePlayerStatsStatement(updated_player_stats) {

  // for each key
  // if key begins with sp, continue

  const keys = Object.keys(updated_player_stats);
  const fields = keys.map(key => `${key} = ?`).join(', ');
  const values = keys.map(key => updated_player_stats[key].value);

  let update_variables = {};
  update_variables.fields = fields;
  update_variables.values = values;

  return update_variables;

}


// accepts match_stats, player_stats
// returns updated_player_stats
function findUpdatedPlayerStats(match_stats, player_stats) {

  updated_player_stats = Object.fromEntries(
    Object.entries(player_stats).map(([key, value]) => [key, { value, new_record: 0 }])
  );

  // currency, outcome, hits, hit received, misses, kills, kill by others, deaths, num plays killed, longest time spent alive, time spent in match, jumps

  // currency
  updated_player_stats.currency_amount.value += match_stats.currencyDelta;

  if (match_stats.currencyDelta > 0) {
    updated_player_stats.mp_currency_earned_alltime.value += match_stats.currencyDelta;
    updated_player_stats.currency_earned_alltime.value += match_stats.currencyDelta;
  }

  // outcome
  if (match_stats.matchOutcome == -1) {updated_player_stats.mp_num_matches_lost_alltime.value += 1}
  else if (match_stats.matchOutcome === 0) {updated_player_stats.mp_num_matches_drawed_alltime.value += 1}
  else if (match_stats.matchOutcome == 1) {updated_player_stats.mp_num_matches_won_alltime.value += 1}

  // hits
  updated_player_stats.mp_num_hits_dealt_alltime.value += match_stats.numHits;
  updated_player_stats.mp_num_hits_received_alltime.value += match_stats.numHitsReceived;
  updated_player_stats.mp_num_misses_dealt_alltime.value += match_stats.numMisses;

  // accuracy 
  const match_accuracy = match_stats.numHits / (match_stats.numMisses + match_stats.numHits);
  if (updated_player_stats.mp_highest_accuracy_in_a_match.value < match_accuracy) {
    updated_player_stats.mp_highest_accuracy_in_a_match.value = match_accuracy;
    updated_player_stats.mp_highest_accuracy_in_a_match.new_record = 1;
  }

  // kills
  updated_player_stats.mp_num_kills_alltime.value += match_stats.numKills;

  // deaths by others
  updated_player_stats.mp_num_deaths_by_other_players_alltime.value += match_stats.numDeathsByOtherPlayers;

  // deaths
  updated_player_stats.mp_num_deaths_alltime.value += match_stats.numDeaths;

  // kills in a match
  if (updated_player_stats.mp_most_kills_in_a_match.value < match_stats.numUniquePlayersKilled) {
    updated_player_stats.mp_most_kills_in_a_match.value = match_stats.numUniquePlayersKilled;
    updated_player_stats.mp_most_kills_in_a_match.new_record = 1;
  }

  // longest time spent alive
  if (updated_player_stats.mp_longest_time_spent_alive_in_a_match_sec.value < match_stats.timeSpentAliveSec) {
    updated_player_stats.mp_longest_time_spent_alive_in_a_match_sec.value = match_stats.timeSpentAliveSec;
    updated_player_stats.mp_longest_time_spent_alive_in_a_match_sec.new_record = 1;
  }

  // match duration
  updated_player_stats.mp_total_time_spent_in_a_match_sec_alltime.value += match_stats.matchDurationSec;

  // jumps
  if (updated_player_stats.mp_most_jumps_in_a_match.value < match_stats.numJumps) {
    updated_player_stats.mp_most_jumps_in_a_match.value = match_stats.numJumps;
    updated_player_stats.mp_most_jumps_in_a_match.new_record = 1;
  }

  updated_player_stats.mp_num_jumps_alltime.value += match_stats.numJumps;

  return updated_player_stats;

  // updated_player_stats
  //   {
  //     ..., 
  //     "timeSpentAliveSec": {
  //        "value": 178.48,
  //        "newRecord": 1
  //     }
  //  }


}

// updates the players stats after a game
// multiple plays could be passed
async function postMatchPlayerStatsUpdate(body) {

  // body
  // [{user_id: 1, stats: {currencyDelta: -250, matchOutcome: 1, ...}, {user_id: 2, stats: {currencyDelta: 250, matchOutcome: -1, ...}]

  // body.stats
  // "currencyDelta": 0,
  // "matchOutcome": 0,
  // "numJumps": 0,
  // "numHits": 0,
  // "numMisses": 0,
  // "numHitsReceived": 0,
  // "numKills": 0,
  // "numUniquePlayersKilled": 0,
  // "numDeaths": 0,
  // "numDeathsByOtherPlayers": 0,
  // "matchDurationSec": 0,
  // "timeSpentAliveSec": 0
  // enum MatchOutcome {
  //   LOSS = -1,
  //   DRAW = 0,
  //   WIN = 1
  // }

  let response = [];

  const db = getDB(); 

  // for each player
    // calculate and update their all time stats
  for (const player of body) {
    
    const user_id = player.user_id;
    let match_stats = player.stats;

    try {

      const query = `SELECT * FROM user_stats WHERE user_id = ?`;
      // Fetch the user from the database
      let [resp] = await db.execute(query, [user_id]);
      player_stats = resp[0];

      if (!player_stats) {

        throw new Error('No matching user stats found.');

      }
      else {

        // remove all single player stats and the user_id
        for (const key in player_stats) {
          if (key.startsWith('sp_') || key == "user_id") {
            delete player_stats[key];
          }
        }

        // create update statement
        let updated_player_stats = findUpdatedPlayerStats(match_stats, player_stats);
        let update_variables = prepareUpdatePlayerStatsStatement(updated_player_stats);

        try {

          const queryUpdate = `
            UPDATE user_stats
            SET ${update_variables.fields}
            WHERE user_id = ?;
          `;

          update_variables.values.push(user_id);

          const [result] = await db.execute(queryUpdate, update_variables.values);

          response.push({"user_id": user_id, "stats": updated_player_stats});

        } catch (error) {

          console.error('Error updating player stats after match:', error.message);
          throw error;

        }
      }

    } catch (error) {
        console.error('Error finding player from user_id when updating player stats after match:', error.message);
        throw error;
    }

  }

  return response;

}

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
        data: result
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

    const app_versions = await fs.readFile("./app_versions.json", "utf-8");

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



  //// stats ////

} // registerStorageRoutes

module.exports = {
  createUser,
  readUser,
  registerStorageRoutes,
};