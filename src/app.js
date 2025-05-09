////// TO DO ///////

// storage process

// track usage

// listen for crash

////// TO DO ///////

const { connectDB } = require('./db');
const storage = require('./storage');
//const networking = require('./networking');

var express = require('express');
var app = express();

// const { exec } = require('child_process');
const { spawn } = require('child_process');

const util = require('util');
//const execPromisified = util.promisify(exec);

 // pre-set ports we use for game instances
const PORTS =  [8080, 8081, 8082, 8083, 8084, 8085];

const MAX_PLAYERS = 4;

// 1:30 is 90,000
const GAME_HEALTH_TIME = 90000;

// master game instance object
var game_instances = {};

async function startServer() {
  await connectDB(); // Connect to Mongo first

  storage.registerStorageRoutes(app);
  //networking.registerNetworkingRoutes(app);

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Rift brain listening on port ${PORT}!`);
  });
}

startServer();

// // // // // // // // // // // // // network functions // // // // // // // // // // // // //

async function runCommand(command, args = [], cwd = '/home/ec2-user/') {
  return new Promise((resolve, reject) => {
      console.log(command, args);
      const child = spawn(command, args, { stdio: 'inherit', cwd, shell:true });

      child.on('spawn', () => {
          console.log("RESOLVE runCommand");
          resolve();
      });

      child.on('error', (err) => {
          console.error(`Error spawning process: ${err.message}`);
          reject(err);
      });
  });
}


// kill the process and the health check timer for a game_instance
async function endGameInstance(game_instance) {

  // run the script to end the game instance
  console.log("BEFORE ENDGAME");

  // run this script for the next port that doesn't have a game
  let command = "kill $(lsof -t -i:" + game_instance + ")";

  console.log("runEndCommand: ", command);
  // await completion
  await runCommand(command);

  console.log("AFTER runCommand");

  // before deleting the game object, clear the time out
  if (game_instances[game_instance]) {
    if (game_instances[game_instance].timer) {
      clearTimeout(game_instances[game_instance].timer);
      console.log("called to remove timer from endGameInstance:", game_instance);
    }
  }

  // remove the game instance from game_instances from the object
  delete game_instances[game_instance];

  return;
}


// this will create a new game instance and store them into the game_instances object
// returns the new game instance port or 1 for wait
async function createGameInstance(private_code = "") {
  // the default return is a wait code of 1
  let new_game_instance_port = 1;

  // find the next port from possible PORTS list that does not already have a game instance
  let unused_ports = PORTS.filter((a) => !game_instances.hasOwnProperty(a));

  if (unused_ports.length > 0) {
      new_game_instance_port = unused_ports[0];

      console.log("BEFORE CREATE GAME");
      // run this script for the next port that doesn't have a game
      let command = "/home/ec2-user/rift_jumper_multiplayer_server_test.x86_64";

      let options = []
      options.push(`--port=${new_game_instance_port}`);
      if (private_code) {
        options.push(` --private_code=${private_code}`);
        console.log("runcom options:", options);
      }

      await runCommand(command, options);
  } else {
      return 1;
  }

  // game_instance object:
  // game_instance[PORTNUM] = {"players":0,"active":false, "healthy":false, "private":false, "private_code":0}
  // players: how many
  // active: the game is mid-session and players are playing
  // healthy: this server is alive and well
  // private: need a game code to join
  // private_code: host lobbies have a password

  // Initialize the game instance object
  game_instances[new_game_instance_port] = {
      players: 0,
      active: false,
      healthy: false,
      private: false,
      private_code: "0",
      timer: null,
  };

  console.log("game_instances", game_instances);

  // Watch the "healthy" property
  return watchProperty(game_instances[new_game_instance_port], "healthy", 5000, false).then((healthyValue) => {
      
      // begin the health timer
      startHealthCheckTimer(new_game_instance_port);

      console.log("Healthy value:", healthyValue);
      console.log("new_game_instance_port:", new_game_instance_port);

      // Conditionally return based on healthyValue
      return healthyValue ? new_game_instance_port : 1;
  });
}

// watch a specific property and if it changes before the timeout, return the new value
function watchProperty(obj, property, timeout, defaultValue) {
  return new Promise((resolve) => {
      let value = obj[property];

      Object.defineProperty(obj, property, {
          configurable: true,
          enumerable: true,
          get() {
              return value;
          },
          set(newValue) {
              console.log("set property: ", newValue);
              clearTimeout(propertyNotSetTimer);
              value = newValue;
              resolve(value); // Resolve the promise when the property changes.
          },
      });

      // Timeout logic
      var propertyNotSetTimer = setTimeout(() => {
          resolve(defaultValue); // Resolve with the default value after timeout.
      }, timeout);
  });
}


// called after the godot instances are created
function startHealthCheckTimer(game_port) {

  // no game_port? its already ended
  if (!game_instances[game_port]) {
    // run kill instance for good measure
    console.log("ending game instance call from startHealthCheclTimer no game_port in obj");
    endGameInstance(game_port);
    return;
  }

  // clear existing timer if it exists
  if (game_instances[game_port].timer) {
      clearTimeout(game_instances[game_port].timer);
  }

  console.log(`Starting timer for game instance ${game_port}`);

  // set a new timeout for const health time
  // the timer is reset when health check endpoint is hit
  game_instances[game_port].timer = setTimeout(() => {
      // if the timer goes off it triggers a shutdown from the linux side of the port game instance
      console.log("ending game instance call from,"+game_port+" timer ran out");
      endGameInstance(game_port);
  }, GAME_HEALTH_TIME);

}


function checkForJoinablePrivateGame(player_submitted_private_code) {

    let game = Object.fromEntries(
    // search for, host code matches, game not started, less than 4 players
    Object.entries(game_instances).filter(([key, value]) => value.private_code == player_submitted_private_code))
    
    let game_port = Object.keys(game)[0];

    // do we have any games with the private code
    if (!Object.keys(game)[0]) {

      // this game doesn't exist
      game_port = 1;
      return game_port;
    }

    // we have a game, is it active?
    if (game[game_port]["active"]) {

      // this game is active
      game_port = 2;
      return game_port;
    }

    // we have a game, is it full?
    if (game[game_port]["players"] >= MAX_PLAYERS) {

      // this game is full
      game_port = 3;
      return game_port;
    }


    console.log(game_port);
    return game_port;

}

// // // // // // // // // // // // // network player instance response api // // // // // // // // // // // // //

app.get('/', function (req, res) {
  let x = 0;
  res.status(200).send(JSON.stringify(x));
});


app.get('/join', async function (req, res) {

  // might pass link?player_submitted_private_code=01234
  var player_submitted_private_code = req.query.player_submitted_private_code;

  // might pass link?create_private_game
  var create_private_game = req.query.create_private_game;

  // the game port is what we return to the player to tell them which game to join
  var game_port = 0;
  var response = {"game_port":game_port};

  if (create_private_game) {

    // create a host code before creating game so we can pass it as needed
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let code = '';
    for (let i = 0;i < 4; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      code += characters[randomIndex];
    }

    let private_code = code;

    game_port = await createGameInstance(private_code);

    // if its not a wait code or a reject
    if (game_port > 1) {
      // set it to private
      game_instances[game_port]["private"] = true;

      // add the host code
      game_instances[game_port]["private_code"] = private_code;

      response["private_code"] = private_code;

    }
  }
  else if (player_submitted_private_code) {
    // search our object of game instances to find the port (key) of the game instance that matches the code
    console.log("player_submitted_private_code:", player_submitted_private_code, game_instances);

    game_port = checkForJoinablePrivateGame(player_submitted_private_code);
    // otherwise if we did not find the game or its not healthy we return a 0 rejected code
  }
  else {
    console.log("no_private_code, dont create a private game");
    // find all healthy games
    // avaiable = not started game, not private game, less than 4 players
    let healthy_games = Object.entries(game_instances).reduce( (i, [key, g]) => {
      if (g.healthy && !g.private && g.players < MAX_PLAYERS) {
        i[key] = g;
      }
      return i;
    }, {});
    console.log("healthy_games", healthy_games);

    // if we dont have any healthy games, create a game or give them a wait code if we have no room
    if (!Object.keys(healthy_games).length) {
      // try to create a new game
      game_port = await createGameInstance();
      // send the response
      res.status(200).send(JSON.stringify({"game_port":game_port}));
      // stop the process
      return;
    }

    // find the first game with more than one player
    let game = Object.entries(healthy_games).find( g => g.players > 0);
    if (game) {
      game_port = game[0];
    }
    else {
      // if we dont have a game with players yet, pick the first one from the healthy list
      game = Object.keys(healthy_games)[0];
      console.log("game:", game);
      if (game) {
        game_port = game;
      }
    }
    // otherwise if cant find an healthy the game we return a 0 wait code 
  }

  // put the new game port in the object before sending it
  response["game_port"] = game_port;
  
  console.log("response: ", response);

  // send the response
  res.status(200).send(JSON.stringify(response));

});

// // // // // // // // // // // // // network game instance response api // // // // // // // // // // // // //

// to access these endpoints you need to be on the same server

// must always pass as queries:
// game_instance=0000

app.get('/health_check', function (req, res) {
  
  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  console.log("HEALTHY CHECK hit: ", passed_game_instance);
  console.log("All game instances: ", game_instances);

  if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
    // reset the health timer by starting it again
    startHealthCheckTimer(passed_game_instance);
  }
  else if (passed_game_instance) {
    // kill the process on that port and delete the game_instance object
    console.log("ending game instance call from /health_check");
    endGameInstance(passed_game_instance);
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
  }

});


app.get('/player_left_instance', function (req, res) {

  console.log("pre-player left: ");

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
    if (game_instances[passed_game_instance]["players"] > 1) {
      // remove a player from the count
      console.log("minus one player");
      game_instances[passed_game_instance]["players"]--;
    }
    else {
      console.log("ending game instance call from player_left_instance");
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

  console.log("pre-player joined: ", game_instances[passed_game_instance]["players"]);
  // add a player
  game_instances[passed_game_instance]["players"]++;
  console.log("post-player joined: ", game_instances[passed_game_instance]["players"]);

  //res.status(200).send(JSON.stringify(x));
});

app.get('/game_started', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  game_instances[passed_game_instance]["active"] = true;

});

app.get('/game_ended', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  game_instances[passed_game_instance]["active"] = false;

});

app.get('/game_instance_ready', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  passed_game_instance = Number(passed_game_instance);
  game_instances[passed_game_instance]["healthy"] = true;

});