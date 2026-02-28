////// TO DO ///////

// storage process

// make more functions and routes that make sense

// send emails / forgot password

////// TO DO ///////

const { connectDB } = require('./db');
const storage = require('./storage');
//const networking = require('./networking');

var express = require('express');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
var app = express();
app.use(express.json());
// Keep request logging minimal and low overhead.
app.use(morgan('tiny'));

// Ensure fatal errors have a dedicated log file outside stdout/stderr.
const fatalLogDir = path.join(__dirname, '..', 'logs');
const fatalLogPath = path.join(fatalLogDir, 'fatal.log');
fs.mkdirSync(fatalLogDir, { recursive: true });

// Central helper to persist fatal errors with context and stack traces.
function logFatalError(err, context) {
  const timestamp = new Date().toISOString();
  const details = err && err.stack ? err.stack : String(err);
  const line = `[${timestamp}] ${context}\n${details}\n`;
  fs.appendFile(fatalLogPath, line, (writeErr) => {
    if (writeErr) {
      console.error('Failed to write fatal log:', writeErr);
    }
  });
}

const { spawn, exec } = require('child_process');

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

// Capture process-level failures so they are recorded as fatal.
process.on('uncaughtException', (err) => {
  logFatalError(err, 'uncaughtException');
});

process.on('unhandledRejection', (err) => {
  logFatalError(err, 'unhandledRejection');
});

// // // // // // // // // // // // // network functions // // // // // // // // // // // // //

async function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    // if this is a binary (not a shell command like "kill ...")
    const isBinary = !command.startsWith("kill ") && !command.includes(" ");

    if (isBinary) {
      // start detached background process
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });

      if (!child.pid) {
        reject(new Error("Failed to spawn process"));
        return;
      }

      console.log(`Spawned process PID: ${child.pid}`);
      child.unref(); // allow parent to exit independently

      resolve(child.pid);
    } else {
      // run shell command (like "kill 1234")
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error("Command failed:", error.message);
          reject(error);
          return;
        }
        if (stderr) console.warn("Command stderr:", stderr);
        resolve(stdout.trim());
      });
    }
  });
}



async function endGameInstance(game_port) {
  console.log("BEFORE ENDGAME");

  const pid = game_instances[game_port]?.pid;
  if (!pid) {
    console.warn("No PID found for game port", game_port);
    return;
  }

  const command = `kill ${pid}`;
  console.log("runEndCommand:", command);

  try {
    await runCommand(command);
    console.log(`Game instance ${game_port} (PID ${pid}) killed successfully.`);
  } catch (err) {
    console.error("Error killing process:", err.message);
  }

  // clear any timers
  if (game_instances[game_port]?.timer) {
    clearTimeout(game_instances[game_port].timer);
    console.log("Removed timer for", game_port);
  }

  delete game_instances[game_port];
}



// this will create a new game instance and store them into the game_instances object
// returns the new game instance port or 1 for wait
async function createGameInstance(private_code = "") {
  let new_game_instance_port = 1;

  const unused_ports = PORTS.filter((a) => !game_instances.hasOwnProperty(a));

  if (unused_ports.length === 0) return 1;

  new_game_instance_port = unused_ports[0];
  const command = "/home/ec2-user/rift_jumper_multiplayer_server_test.x86_64";
  const options = [`--port=${new_game_instance_port}`];
  if (private_code) options.push(`--private_code=${private_code}`);

  console.log("Launching game:", command, options);

  // 🧩 get the PID directly
  const pid = await runCommand(command, options);

  // Create instance record
  game_instances[new_game_instance_port] = {
    players: 0,
    active: false,
    healthy: false,
    private: !!private_code,
    private_code: private_code || "0",
    timer: null,
    pid, // 💾 store the PID
  };

  console.log(`Game instance created on port ${new_game_instance_port} (pid ${pid})`);

  return watchProperty(game_instances[new_game_instance_port], "healthy", 5000, false)
    .then((healthyValue) => {
      startHealthCheckTimer(new_game_instance_port);
      console.log("Healthy value:", healthyValue);
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

// // Crash test endpoint to validate fatal logging behavior.
// app.get('/crash-test', function (req, res) {
//   throw new Error('Crash test requested');
// });

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
      if (g.healthy && !g.active && !g.private && g.players < MAX_PLAYERS) {
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

app.get('/server_health_check', function (req, res) {
  res.json(true);
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

// Treat unexpected route errors as fatal and return a safe 500 response.
app.use(function (err, req, res, next) {
  logFatalError(err, `express ${req.method} ${req.originalUrl}`);
  res.status(500).json({ error: 'Internal server error' });
});
