////// TO DO ///////

// await promise exec function from OS

// adjust the godot game instance build, probably also needs to be able to reject player who try to join when not available?

// adjust the player instance build to send requests and handle codes like reject and wait

// create the health check timer for each game instance

// test creating and killing processes from node

////// TO DO ///////

var express = require('express');
var app = express();

const util = require('util');
const exec = util.promisify(require('child_process').exec);

 // pre-set ports we use for game instances
const PORTS =  [8080, 8081, 8082, 8083, 8084, 8085];

var game_instances = {};

// we want this one listening on port 3000
app.listen(3000, function () {
  console.log('Rift brain listening on port 3000!');
});


async function lsExample() {
  console.log("HIT lsExample");
  try {
    console.log("TRY lsExample");
    const { stdout, stderr } = await exec('ls');
    console.log("DONE lsExample");
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
  } catch (e) {
    console.error(e); // should contain code (exit code) and signal (that caused the termination).
  }
}

// this will create a new game instance and store them into the game_instances object
// returns the new game instance port
function createGameInstance() {

  console.log("createGameInstance");

  // the default return is a wait code of 1
  let new_game_instance_port = 1;

  // find the next available port that does not already have a game instance
  let unused_ports = PORTS.filter( a => !game_instances.hasOwnProperty(a) )
  console.log("game_instances:", game_instances);
  if (Object.keys(unused_ports).length > 0) {
    new_game_instance_port = unused_ports[0];
    console.log("BEFORE lsExample");
    // run this script for the next port that doesn't have a game
    // let script = "./rift_jumper_multiplayer_server.x86_64 --port=" + key;
    lsExample();
    console.log("AFTER lsExample");
  }
  else {
    return 1;
  }

  // create the brains tracking object for each game instance
  game_instances[new_game_instance_port] = {"players":0,"active":false, "available":true, "private":false, "game_code":0};

  return new_game_instance_port;
}

// kill the process and the health check timer for a game_instance
function endGameInstance(game_instance) {
    // run the script to end the game instance
    // await completion
    // kill the timer
    // remove the game instance from game_instances
    return;
}

// called after the godot instances are created
function startHealthCheck() {

  // there is also a timer on the game_instance godot side that pings the healthcheck endpoint below every thirty seconds

  // set a timer

  // the timer is 1:30 and reset when health check endpoint is hit

  // if the timer goes off it triggers a shutdown from the linux side of the port game instance

}


// // // // // // // // // // // // // player instance response api // // // // // // // // // // // // //

app.get('/', function (req, res) {
  let x = 0;
  res.status(200).send(JSON.stringify(x));
});


app.get('/join', function (req, res) {

  // might pass link?player_submitted_game_code=01234
  var player_submitted_game_code = req.query.player_submitted_game_code;

  // the game port is what we return to the player to tell them which game to join
  var game_port = 0;
  
  // search our object of game instances to find the port (key) of the game instance that matches the code
  if (player_submitted_game_code) {
    console.log("player_submitted_game_code:", player_submitted_game_code, game_instances);
    //let x = Object.entries(game_instances).filter( (g) => g.game_code == player_submitted_game_code);
    let x = Object.fromEntries(
      Object.entries(game_instances).filter(([key, value]) => value.game_code == player_submitted_game_code && value.available) )
    console.log(x);
    if (x) {
        game_port = Object.keys(x)[0];
    }
    else {
        game_port = 0;
    }
    // otherwise if we did not find the game or its not available we return a 0 rejected code
  }
  else {
    console.log("no_game_code:");
    // find all available games
    let available_games = Object.entries(game_instances).reduce( (i, [key, g]) => {
      if (g.available && !g.private) {
        i[key] = g;
      }
      return i;
    }, {});
    console.log("available_games", available_games);

    // if we dont have any available games, give them a wait code, 1
    if (!Object.keys(available_games).length) {
      // try to create a new game
      game_port = createGameInstance();
      // send the response
      res.status(200).send(JSON.stringify({"game_port":game_port}));
      // stop the process
      return;
    }

    // find the first game with more than one player
    let game = Object.entries(available_games).find( g => g.players > 0);
    if (game) {
      game_port = game[0];
    }
    else {
      // if we dont have a game with players yet, pick the first one from the available list
      game = Object.keys(available_games)[0];
      console.log("game:", game);
      if (game) {
        game_port = game;
      }
    }
    // otherwise if cant find an available the game we return a 0 wait code 
  }

  // send the response
  res.status(200).send(JSON.stringify({"game_port":game_port}));

});

app.get('/host', function (req, res) {
  
  // our vars to returns
  var game_port = 0;
  var host_code = 0;

  // search for available
  // let available_games = Object.entries(game_instances).reduce( (i, [key, g]) => {
  //   if (g.available) {
  //     i[key] = g;
  //   }
  //   return i;
  // }, {});

  // // find the next available port that does not already have a game instance
  // let unused_ports = PORTS.filter( a => !game_instances.hasOwnProperty(a) )

  // if (Object.keys(unused_ports).length > 0) {
  //   // get the first one
  //   game_port = Object.keys(unused_ports)[0];
  // }
  // else {
  //   // we dont have any avaiable games, await trying to create game instance
  //   // returns 1 if no more room and player must wait, returns game_port
  game_port = createGameInstance();
  //}

  // if its not a wait code or a reject
  if (game_port > 1) {
    // set it to private
    game_instances[game_port]["private"] = true;

    // create a host code 
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = '';
    for (let i = 0;i < 5; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      code += characters[randomIndex];
    }

    host_code = code;

    // add the host code
    game_instances[game_port]["game_code"] = host_code;
  }
  
  // return the port and the host code
  res.status(200).send(JSON.stringify({"game_port":game_port, "host_code":host_code}));

});


// // // // // // // // // // // // // game instance response api // // // // // // // // // // // // //

// to access these endpoints you need to be on the same server? is that possible?

// must always pass as queries:
// game_instance=0000

app.get('/health_check', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  let passed_player_count = req.query.player_count;

  let passed_available = req.query.available;

  let passed_active = req.query.active;

  if (passed_game_instance && passed_player_count &&  passed_available && passed_active && game_instances.hasOwnProperty(passed_game_instance)) {
    // set with the latest data
    game_instances[passed_game_instance]["players"] = passed_player_count;
    game_instances[passed_game_instance]["available"] = passed_available;
    game_instances[passed_game_instance]["active"] = passed_active;
  }
  else if (passed_game_instance) {
    // kill the process on that port and the timer asking for health checks
    endGameInstance(passed_game_instance);
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
  }

});


app.get('/player_left_instance', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
    if (game_instances[passed_game_instance]["players"] < 0) {
      // remove a player from the count
      game_instances[passed_game_instance]["players"]--;
    }
    else {
      endGameInstance(passed_game_instance);
    }
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
  }

  //res.status(200).send(JSON.stringify(x));
});

app.get('/player_joined_instance', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  // add a player
  game_instances[passed_game_instance]["players"]++;

  //res.status(200).send(JSON.stringify(x));
});

app.get('/game_instance_started', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  game_instances[passed_game_instance]["available"] = false;

  //res.status(200).send(JSON.stringify(x));
});

app.get('/game_instance_ended', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  game_instances[passed_game_instance]["available"] = true;

  //res.status(200).send(JSON.stringify(x));
});