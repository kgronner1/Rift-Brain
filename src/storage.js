// db import
const { getDB } = require('./db');
const bcrypt = require('bcryptjs');  // Import bcrypt for password hashing

// // // // // // // // PLAYER STORAGE FUNCTIONS // // // // // // // //

// accepts player is an object
// returns 
async function createPlayer(player) {
  // Validate required fields
  const requiredFields = ['device_id', 'name', 'ship_sprite', 'email', 'password'];
  
  for (const field of requiredFields) {
    if (!player[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // db store the player
  const db = getDB(); // Assuming getDB returns the database connection pool or connection object

  // Hash the password before storing
  const hashedPassword = await bcrypt.hash(player.password, 10);  // Hashing with a salt rounds of 10

  // MySQL query to insert a new player
  const query = `
    INSERT INTO players (device_id, name, ship_sprite, available_sprites, points, unlocked_levels, email, password, created_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW());
  `;

  // Values to insert
  const values = [
    player.device_id,
    player.name,
    player.ship_sprite,
    JSON.stringify([0,1,2]), // Convert array to JSON string
    0,
    0,
    player.email,
    hashedPassword,  // Storing hashed password
  ];

  try {
    // Execute the query
    const [result] = await db.execute(query, values);
    
    // Log the result (optional)
    console.log(result);

    // Return the player_id (assuming auto-increment)
    return result.insertId; // The ID of the newly created player
  } catch (error) {
    // Handle any errors
    console.error('Error creating player:', error);
    throw error;
  }
}


async function readPlayer(player_id) {
  const db = getDB();
  const [rows] = await db.query('SELECT * FROM users');
  console.log(rows);
  return result.insertedId;
}

async function updatePlayer(player) {

}

async function deletePlayer(player_id) {

}


// Function to check user login credentials
async function loginPlayer(email, password) {
  const db = getDB(); // Assuming getDB returns the database connection pool or connection object
  
  // Query to fetch the player by email (you can modify this if you use another field)
  const query = `SELECT * FROM players WHERE email = ?`;
  
  try {
    // Fetch the player from the database
    const [rows] = await db.execute(query, [email]);
    
    if (rows.length === 0) {
      // If no player found with this email
      throw new Error('No player found with this email');
    }

    const player = rows[0]; // The first row is the matching player

    // Compare the plain-text password with the stored hashed password
    const isPasswordCorrect = await bcrypt.compare(password, player.password);

    if (isPasswordCorrect) {
      // If the password matches
      console.log('Login successful');
      return player; // Return the player data (or a session token, etc.)
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

// accepts game is an object
// returns true or false
async function createFinishedMultiplayerGame(game) {

}

async function readFinishedMultiplayerGame(game_id) {

}

async function readPlayersMultiplayerGames(player_id) {
  // return all games of a single player
}

async function readLeaderboardMultiplayerGames() {
  // return players count #1 placements
  const db = getDB();

}

// // // // // // // // // // // // // storage response api // // // // // // // // // // // // //

// // // Player // // //
// player_id | Unique Int
// device_id | String
// name | String
// ship_sprite | Int
// available_sprites | Array of Ints
// points | Int
// unlocked_levels | Int
// email | String
// password | String
// created_date | Date

function registerStorageRoutes(app) {

  app.get('/create_player', function (req, res) {

    let response = [];
    response["success"] = createPlayer(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });

  app.get('/read_player', function (req, res) {

    let response = [];
    response["success"] = createPlayer(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });

  app.get('/update_player', function (req, res) {

    let response = [];
    response["success"] = updatePlayer(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });

  app.get('/delete_player', function (req, res) {

    let response = [];
    response["success"] = deletePlayer(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });

  // // // Game // // //
  // game_id | Unique Int
  // player_id | Int
  // asteroids_hit | Int
  // missed_shots | Int
  // successful_shots | Int
  // placement | Int
  // participants | Array of player_ids
  // times_hit | Int
  // date | Date

  app.get('/create_finished_multiplayer_game', function (req, res) {

    let response = [];
    response["success"] = createFinishedMultiplayerGame(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });


  ///////////////////////////// specialty endpoints ///////////////////////////

  app.get('/read_players_multiplayer_games', function (req, res) {

    let response = [];
    response["success"] = readPlayersMultiplayerGames(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });

  app.get('/read_leaderboard', function (req, res) {

    let response = [];
    response["success"] = readLeaderboardMultiplayerGames(req);

    // send the response
    res.status(200).send(JSON.stringify(response));

  });

} // registerStorageRoutes


module.exports = {
  createPlayer,
  readPlayer,
  registerStorageRoutes,
};