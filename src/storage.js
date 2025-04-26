// db import
const { getDB } = require('./db');

// // // // // // // // PLAYER STORAGE FUNCTIONS // // // // // // // //

// accepts player is an object
// returns true or false
async function createPlayer(player) {
  // db store the player
  const db = getDB();
  const result = await db.collection('players').insertOne(player);
  console.log('Player created with id:', result.insertedId);
  return result.insertedId;
}

async function readPlayer(player_id) {
  const db = getDB();
  const { ObjectId } = require('mongodb');
  const player = await db.collection('players').findOne({ _id: new ObjectId(playerId) });
  return player;
}

async function updatePlayer(player) {

}

async function deletePlayer(player_id) {

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

  const topPlayers = await db.collection('games').aggregate([
    {
      $match: { placement: 1 }
    },
    {
      $group: {
        _id: "$player_id",
        first_place_count: { $sum: 1 }
      }
    },
    {
      $lookup: {
        from: "players",               // collection to join
        localField: "_id",              // _id from games aggregation
        foreignField: "player_id",      // player_id field in players
        as: "player_info"               // output array
      }
    },
    {
      $unwind: "$player_info"           // since we expect exactly one match per player
    },
    {
      $project: {
        _id: 0,
        player_id: "$_id",
        first_place_count: 1,
        name: "$player_info.name",
        ship_sprite: "$player_info.ship_sprite"
      }
    },
    {
      $sort: { first_place_count: -1 }
    },
    {
      $limit: 10
    }
  ]).toArray();

  return topPlayers;
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