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
const crypto = require('crypto');

const util = require('util');
//const execPromisified = util.promisify(exec);

 // pre-set ports we use for game instances
const PORTS =  [8080, 8081, 8082, 8083, 8084, 8085];

const MAX_PLAYERS = 4;

// 1:30 is 90,000
const GAME_HEALTH_TIME = 90000;

// master game instance object
var game_instances = {};

// // // // // // // // // // // // // join queue // // // // // // // // // // // // //

// A ticket is purged if it hasn't been polled for this long
const QUEUE_TICKET_POLL_TTL = 75000;
// An admitted ticket's slot reservation expires if the player never connects
const QUEUE_RESERVATION_TTL = 20000;
const QUEUE_SWEEP_INTERVAL = 5000;

// FIFO queue of join tickets (array order == submission order):
// { ticket_id, submitted_at, last_poll_at, target_port|null, admitted_port|null, admitted_at|null }
// target_port set = private-code join waiting on one specific lobby
// target_port null = public quickplay waiting on any open public lobby
var join_queue = [];

function createJoinTicket(target_port = null) {
  const now = Date.now();
  const ticket = {
    ticket_id: crypto.randomUUID(),
    submitted_at: now,
    last_poll_at: now,
    target_port: target_port === null ? null : Number(target_port),
    admitted_port: null,
    admitted_at: null,
  };
  join_queue.push(ticket);
  return ticket;
}

// Admitted-but-not-yet-connected tickets count against lobby capacity,
// so a direct /join can't steal a promised seat
function reservedCount(game_port) {
  const port = Number(game_port);
  return join_queue.filter((t) => t.admitted_port === port).length;
}

function lobbyHasOpenSlot(game_port) {
  const g = game_instances[game_port];
  return !!g
    && g.healthy
    && g.lobby_state === 'PREGAME'
    && (g.players + reservedCount(game_port)) < MAX_PLAYERS;
}

function drainJoinQueue() {
  for (const ticket of join_queue) {
    if (ticket.admitted_port !== null) continue;

    let admit_port = null;
    if (ticket.target_port !== null) {
      if (lobbyHasOpenSlot(ticket.target_port)) admit_port = ticket.target_port;
    } else {
      // public ticket: first-fit against any open public lobby
      const open_port = Object.keys(game_instances)
        .find((p) => !game_instances[p].private && lobbyHasOpenSlot(p));
      if (open_port) admit_port = Number(open_port);
    }

    if (admit_port !== null) {
      ticket.admitted_port = admit_port;
      ticket.admitted_at = Date.now();
      console.log(`Ticket ${ticket.ticket_id} admitted to game instance ${admit_port}`);
    }
  }
}

// Called when a lobby process dies: its tickets must go invalid on next poll
function invalidateTicketsForPort(game_port) {
  const port = Number(game_port);
  join_queue = join_queue.filter((t) => t.target_port !== port && t.admitted_port !== port);
}

setInterval(() => {
  const now = Date.now();
  const num_tickets_before = join_queue.length;
  join_queue = join_queue.filter((t) => {
    if (now - t.last_poll_at > QUEUE_TICKET_POLL_TTL) return false;
    if (t.admitted_port !== null && now - t.admitted_at > QUEUE_RESERVATION_TTL) return false;
    return true;
  });
  if (join_queue.length < num_tickets_before) {
    console.log(`Queue sweep purged ${num_tickets_before - join_queue.length} ticket(s)`);
  }
  drainJoinQueue();
}, QUEUE_SWEEP_INTERVAL);

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

  // dead lobby: any tickets waiting on (or admitted to) it must go invalid
  invalidateTicketsForPort(game_port);
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
    // PREGAME | INGAME | POSTGAME -- joins are only admitted while PREGAME.
    // (POSTGAME lobbies are mid-rematch-flow, not joinable fresh lobbies.)
    lobby_state: 'PREGAME',
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


// returns { game_port, ticket_id? } where game_port is either a real port or
// a sentinel: 1 = no such game, 3 = full, 4 = queued (ticket_id included)
function checkForJoinablePrivateGame(player_submitted_private_code) {

    const entry = Object.entries(game_instances)
      .find(([, g]) => g.private_code == player_submitted_private_code);

    // do we have any games with the private code
    if (!entry) {
      return { game_port: 1 };
    }

    const [game_port, game] = entry;

    // we have a game, is a match in progress (or wrapping up)?
    // instead of a hard reject, queue the player for the next PREGAME window
    if (game.lobby_state !== 'PREGAME') {
      const ticket = createJoinTicket(game_port);
      return { game_port: 4, ticket_id: ticket.ticket_id };
    }

    // we have a game, is it full? (admitted-but-unconnected tickets hold seats)
    if (game.players + reservedCount(game_port) >= MAX_PLAYERS) {
      return { game_port: 3 };
    }

    console.log(game_port);
    return { game_port: Number(game_port) };

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

    const check = checkForJoinablePrivateGame(player_submitted_private_code);
    game_port = check.game_port;
    if (check.ticket_id) {
      response["ticket_id"] = check.ticket_id;
    }
  }
  else {
    console.log("no_private_code, dont create a private game");
    // find all healthy games
    // avaiable = lobby in PREGAME, not private game, less than 4 players
    // (seats reserved for admitted-but-unconnected queue tickets count as taken)
    let healthy_games = Object.entries(game_instances).reduce( (i, [key, g]) => {
      if (g.healthy && g.lobby_state === 'PREGAME' && !g.private && (g.players + reservedCount(key)) < MAX_PLAYERS) {
        i[key] = g;
      }
      return i;
    }, {});
    console.log("healthy_games", healthy_games);

    // if we dont have any healthy games, create a game, or queue the player if we have no room
    if (!Object.keys(healthy_games).length) {
      // try to create a new game
      game_port = await createGameInstance();
      if (game_port === 1) {
        // no room for a new instance: queue the player for the next open public slot
        const ticket = createJoinTicket(null);
        game_port = 4;
        response["ticket_id"] = ticket.ticket_id;
      }
      response["game_port"] = game_port;
      // send the response
      res.status(200).send(JSON.stringify(response));
      // stop the process
      return;
    }

    // find the first game with more than one player
    let game = Object.entries(healthy_games).find(([, g]) => g.players > 0);
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

  res.status(200).json({ success: true });
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

      // a seat may have opened in a joinable lobby
      if (game_instances[passed_game_instance]["lobby_state"] === 'PREGAME') {
        drainJoinQueue();
      }
    }
    else {
      console.log("ending game instance call from player_left_instance");
      endGameInstance(passed_game_instance);
    }
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
  }

  res.status(200).json({ success: true });
});



app.get('/player_joined_instance', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  if (!passed_game_instance || !game_instances.hasOwnProperty(passed_game_instance)) {
    console.log("FAILED TO PASS GAME INSTANCE");
    res.status(200).json({ success: false, message: 'unknown game_instance' });
    return;
  }

  console.log("pre-player joined: ", game_instances[passed_game_instance]["players"]);
  // add a player
  game_instances[passed_game_instance]["players"]++;
  console.log("post-player joined: ", game_instances[passed_game_instance]["players"]);

  // The game server can't tell us WHICH joiner this was, so we approximate:
  // release the oldest outstanding reservation for this port. If the joiner was
  // actually a direct (unqueued) join, this frees a reservation early and the
  // queued player still connects on their admitted port -- worst case is a
  // brief over-admission race, never a leaked seat.
  const port = Number(passed_game_instance);
  const reservation_index = join_queue.findIndex((t) => t.admitted_port === port);
  if (reservation_index !== -1) {
    console.log(`Consuming reservation ${join_queue[reservation_index].ticket_id} for port ${port}`);
    join_queue.splice(reservation_index, 1);
  }

  res.status(200).json({ success: true });
});

app.get('/game_started', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
    game_instances[passed_game_instance]["lobby_state"] = 'INGAME';
    res.status(200).json({ success: true });
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
    res.status(200).json({ success: false, message: 'unknown game_instance' });
  }

});

app.get('/game_ended', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
    game_instances[passed_game_instance]["lobby_state"] = 'POSTGAME';
    res.status(200).json({ success: true });
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
    res.status(200).json({ success: false, message: 'unknown game_instance' });
  }

});

app.get('/game_returned_to_pregame', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
    game_instances[passed_game_instance]["lobby_state"] = 'PREGAME';
    drainJoinQueue();
    res.status(200).json({ success: true });
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
    res.status(200).json({ success: false, message: 'unknown game_instance' });
  }

});

// // // // // // // // // // // // // join queue api // // // // // // // // // // // // //

app.get('/join_queue_status', function (req, res) {

  const ticket_id = req.query.ticket_id;
  const ticket = join_queue.find((t) => t.ticket_id === ticket_id);

  // unknown ticket: purged, consumed, invalidated, or lost to a brain restart
  if (!ticket) {
    res.status(200).json({ status: 'invalid' });
    return;
  }

  ticket.last_poll_at = Date.now();

  if (ticket.admitted_port !== null) {
    res.status(200).json({ status: 'admitted', game_port: ticket.admitted_port });
    return;
  }

  // position among unadmitted tickets waiting on the same lobby (or, for
  // public tickets, among all unadmitted public tickets)
  const peers = join_queue.filter((t) =>
    t.admitted_port === null && t.target_port === ticket.target_port);
  res.status(200).json({ status: 'queued', position: peers.indexOf(ticket) + 1 });

});

app.get('/leave_queue', function (req, res) {

  const ticket_id = req.query.ticket_id;
  const index = join_queue.findIndex((t) => t.ticket_id === ticket_id);

  if (index === -1) {
    res.status(200).json({ status: 'invalid' });
    return;
  }

  join_queue.splice(index, 1);
  res.status(200).json({ status: 'removed' });

});

app.get('/game_instance_ready', function (req, res) {

  // what game instance is this? this must be passed as a query
  let passed_game_instance = req.query.game_instance;

  passed_game_instance = Number(passed_game_instance);
  if (game_instances.hasOwnProperty(passed_game_instance)) {
    game_instances[passed_game_instance]["healthy"] = true;
    drainJoinQueue();
    res.status(200).json({ success: true });
  }
  else {
    console.log("FAILED TO PASS GAME INSTANCE");
    res.status(200).json({ success: false, message: 'unknown game_instance' });
  }

});

// Treat unexpected route errors as fatal and return a safe 500 response.
app.use(function (err, req, res, next) {
  logFatalError(err, `express ${req.method} ${req.originalUrl}`);
  res.status(500).json({ error: 'Internal server error' });
});
