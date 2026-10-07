// Today's matchmaking and lobby-lifecycle routes, unchanged in path and shape.
// /v1/match/join and /internal/v1/* replace them in M4; these go at cutover.

const { MAX_PLAYERS } = require('../../match/lobbies');

function registerLobbyRoutes(app, lobbies) {

  // // // // // // // // // // // // // network player instance response api // // // // // // // // // // // // //

  app.get('/', function (req, res) {
    let x = 0;
    res.status(200).send(JSON.stringify(x));
  });

  app.get('/join', async function (req, res) {
    const game_instances = lobbies.game_instances;

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

      game_port = await lobbies.createGameInstance(private_code);

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

      const check = lobbies.checkForJoinablePrivateGame(player_submitted_private_code);
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
        if (g.healthy && g.lobby_state === 'PREGAME' && !g.private && (g.players + lobbies.reservedCount(key)) < MAX_PLAYERS) {
          i[key] = g;
        }
        return i;
      }, {});
      console.log("healthy_games", healthy_games);

      // if we dont have any healthy games, create a game, or queue the player if we have no room
      if (!Object.keys(healthy_games).length) {
        // try to create a new game
        game_port = await lobbies.createGameInstance();
        if (game_port === 1) {
          // no room for a new instance: queue the player for the next open public slot
          const ticket = lobbies.createJoinTicket(null);
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
    const game_instances = lobbies.game_instances;

    // what game instance is this? this must be passed as a query
    let passed_game_instance = req.query.game_instance;

    console.log("HEALTHY CHECK hit: ", passed_game_instance);
    console.log("All game instances: ", game_instances);

    if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
      // reset the health timer by starting it again
      lobbies.startHealthCheckTimer(passed_game_instance);
    }
    else if (passed_game_instance) {
      // kill the process on that port and delete the game_instance object
      console.log("ending game instance call from /health_check");
      lobbies.endGameInstance(passed_game_instance);
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
    const game_instances = lobbies.game_instances;

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
          lobbies.drainJoinQueue();
        }
      }
      else {
        console.log("ending game instance call from player_left_instance");
        lobbies.endGameInstance(passed_game_instance);
      }
    }
    else {
      console.log("FAILED TO PASS GAME INSTANCE");
    }

    res.status(200).json({ success: true });
  });



  app.get('/player_joined_instance', function (req, res) {
    const game_instances = lobbies.game_instances;

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
    const join_queue = lobbies.join_queue;
    const reservation_index = join_queue.findIndex((t) => t.admitted_port === port);
    if (reservation_index !== -1) {
      console.log(`Consuming reservation ${join_queue[reservation_index].ticket_id} for port ${port}`);
      lobbies.removeTicketAt(reservation_index);
    }

    res.status(200).json({ success: true });
  });

  app.get('/game_started', function (req, res) {
    const game_instances = lobbies.game_instances;

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
    const game_instances = lobbies.game_instances;

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
    const game_instances = lobbies.game_instances;

    // what game instance is this? this must be passed as a query
    let passed_game_instance = req.query.game_instance;

    if (passed_game_instance && game_instances.hasOwnProperty(passed_game_instance)) {
      game_instances[passed_game_instance]["lobby_state"] = 'PREGAME';
      lobbies.drainJoinQueue();
      res.status(200).json({ success: true });
    }
    else {
      console.log("FAILED TO PASS GAME INSTANCE");
      res.status(200).json({ success: false, message: 'unknown game_instance' });
    }

  });

  // // // // // // // // // // // // // join queue api // // // // // // // // // // // // //

  app.get('/join_queue_status', function (req, res) {
    const join_queue = lobbies.join_queue;

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
    const join_queue = lobbies.join_queue;

    const ticket_id = req.query.ticket_id;
    const index = join_queue.findIndex((t) => t.ticket_id === ticket_id);

    if (index === -1) {
      res.status(200).json({ status: 'invalid' });
      return;
    }

    lobbies.removeTicketAt(index);
    res.status(200).json({ status: 'removed' });

  });

  app.get('/game_instance_ready', function (req, res) {
    const game_instances = lobbies.game_instances;

    // what game instance is this? this must be passed as a query
    let passed_game_instance = req.query.game_instance;

    passed_game_instance = Number(passed_game_instance);
    if (game_instances.hasOwnProperty(passed_game_instance)) {
      game_instances[passed_game_instance]["healthy"] = true;
      lobbies.drainJoinQueue();
      res.status(200).json({ success: true });
    }
    else {
      console.log("FAILED TO PASS GAME INSTANCE");
      res.status(200).json({ success: false, message: 'unknown game_instance' });
    }

  });

}

module.exports = { registerLobbyRoutes };
