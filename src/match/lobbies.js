const log = require('../log');
const crypto = require('crypto');
const { firstFreePort } = require('./ports');
const { runCommand: defaultRunCommand } = require('./process');

const MAX_PLAYERS = 4;

// 1:30 is 90,000
const GAME_HEALTH_TIME = 90000;

// A ticket is purged if it hasn't been polled for this long
const QUEUE_TICKET_POLL_TTL = 75000;
// An admitted ticket's slot reservation expires if the player never connects
const QUEUE_RESERVATION_TTL = 20000;
const QUEUE_SWEEP_INTERVAL = 5000;

// How long a new game instance has to report /game_instance_ready
const GAME_READY_TIMEOUT = 5000;

// The game instances and the join queue, held in process memory.
// ports and serverBinary come from config/env.js; runCommand and now are injectable for tests.
function createLobbyRegistry({
  ports,
  serverBinary,
  runCommand = defaultRunCommand,
  now = () => Date.now(),
  readyTimeoutMs = GAME_READY_TIMEOUT,
  healthTimeMs = GAME_HEALTH_TIME,
}) {

  // master game instance object
  var game_instances = {};

  // FIFO queue of join tickets (array order == submission order):
  // { ticket_id, submitted_at, last_poll_at, target_port|null, admitted_port|null, admitted_at|null }
  // target_port set = private-code join waiting on one specific lobby
  // target_port null = public quickplay waiting on any open public lobby
  var join_queue = [];

  let sweepTimer = null;

  function createJoinTicket(target_port = null) {
    const t = now();
    const ticket = {
      ticket_id: crypto.randomUUID(),
      submitted_at: t,
      last_poll_at: t,
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
        ticket.admitted_at = now();
        log.info(`Ticket ${ticket.ticket_id} admitted to game instance ${admit_port}`);
      }
    }
  }

  // Called when a lobby process dies: its tickets must go invalid on next poll
  function invalidateTicketsForPort(game_port) {
    const port = Number(game_port);
    join_queue = join_queue.filter((t) => t.target_port !== port && t.admitted_port !== port);
  }

  function sweepJoinQueue() {
    const t = now();
    const num_tickets_before = join_queue.length;
    join_queue = join_queue.filter((ticket) => {
      if (t - ticket.last_poll_at > QUEUE_TICKET_POLL_TTL) return false;
      if (ticket.admitted_port !== null && t - ticket.admitted_at > QUEUE_RESERVATION_TTL) return false;
      return true;
    });
    if (join_queue.length < num_tickets_before) {
      log.info(`Queue sweep purged ${num_tickets_before - join_queue.length} ticket(s)`);
    }
    drainJoinQueue();
  }

  function start() {
    if (!sweepTimer) sweepTimer = setInterval(sweepJoinQueue, QUEUE_SWEEP_INTERVAL);
  }

  // Tests only: clears every timer so the process can exit. Kills nothing.
  function stop() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    for (const g of Object.values(game_instances)) {
      if (g.timer) clearTimeout(g.timer);
    }
  }

  async function endGameInstance(game_port) {
    log.info("BEFORE ENDGAME");

    const pid = game_instances[game_port]?.pid;
    if (!pid) {
      log.warn("No PID found for game port", game_port);
      return;
    }

    const command = `kill ${pid}`;
    log.info("runEndCommand:", command);

    try {
      await runCommand(command);
      log.info(`Game instance ${game_port} (PID ${pid}) killed successfully.`);
    } catch (err) {
      log.error("Error killing process:", err.message);
    }

    // clear any timers
    if (game_instances[game_port]?.timer) {
      clearTimeout(game_instances[game_port].timer);
      log.info("Removed timer for", game_port);
    }

    delete game_instances[game_port];

    // dead lobby: any tickets waiting on (or admitted to) it must go invalid
    invalidateTicketsForPort(game_port);
  }

  // this will create a new game instance and store them into the game_instances object
  // returns the new game instance port or 1 for wait
  async function createGameInstance(private_code = "") {
    const new_game_instance_port = firstFreePort(ports, game_instances);

    if (new_game_instance_port === null) return 1;

    const command = serverBinary;
    const options = [`--port=${new_game_instance_port}`];
    if (private_code) options.push(`--private_code=${private_code}`);

    log.info("Launching game:", command, options);

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
      pid,
    };

    log.info(`Game instance created on port ${new_game_instance_port} (pid ${pid})`);

    return watchProperty(game_instances[new_game_instance_port], "healthy", readyTimeoutMs, false)
      .then((healthyValue) => {
        startHealthCheckTimer(new_game_instance_port);
        log.info("Healthy value:", healthyValue);
        return healthyValue ? new_game_instance_port : 1;
      });
  }

  // called after the godot instances are created
  function startHealthCheckTimer(game_port) {

    // no game_port? its already ended
    if (!game_instances[game_port]) {
      // run kill instance for good measure
      log.info("ending game instance call from startHealthCheclTimer no game_port in obj");
      endGameInstance(game_port);
      return;
    }

    // clear existing timer if it exists
    if (game_instances[game_port].timer) {
        clearTimeout(game_instances[game_port].timer);
    }

    log.info(`Starting timer for game instance ${game_port}`);

    // set a new timeout for const health time
    // the timer is reset when health check endpoint is hit
    game_instances[game_port].timer = setTimeout(() => {
        // if the timer goes off it triggers a shutdown from the linux side of the port game instance
        log.info("ending game instance call from,"+game_port+" timer ran out");
        endGameInstance(game_port);
    }, healthTimeMs);

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

      log.info(game_port);
      return { game_port: Number(game_port) };

  }

  return {
    get game_instances() { return game_instances; },
    get join_queue() { return join_queue; },
    removeTicketAt(index) { join_queue.splice(index, 1); },
    createJoinTicket,
    reservedCount,
    lobbyHasOpenSlot,
    drainJoinQueue,
    invalidateTicketsForPort,
    sweepJoinQueue,
    endGameInstance,
    createGameInstance,
    startHealthCheckTimer,
    checkForJoinablePrivateGame,
    start,
    stop,
  };
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
              log.info("set property: ", newValue);
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

module.exports = {
  createLobbyRegistry,
  watchProperty,
  MAX_PLAYERS,
  GAME_HEALTH_TIME,
  QUEUE_TICKET_POLL_TTL,
  QUEUE_RESERVATION_TTL,
  QUEUE_SWEEP_INTERVAL,
};
