'use strict';
// The lobby registry of a new environment (spec M4; the legacy brain keeps match/lobbies.js). In process memory,
// keyed by a random lobby_id:
//   { id, wire, fp, port, pid, state, privateCode, seats: seat -> {uid, status: reserved|seated, expiresAt}, bots,
//     lastHeartbeat, adopted, everSeated }
// and the lobby-wait queue (the `lobby` kind of spec 4.2's `queued`), FIFO in insertion order.
//
// - Routing: a client on (wire, fp) plays only in (wire, fp) lobbies; manifest.js says which pairs are deployed.
// - A join token reserves a seat for its 60 s; capacity is seated humans + reservations + bots < 4.
// - A lobby is spawned on a port of GAME_PORTS that no lobby holds and that passes a UDP bind test.
// - A lobby whose server process exits (seen while this brain is its parent) ends at once.
// - Crash loops: CRASH_LOOP_LIMIT lobbies of one (wire, fp) in a row that die before their first heartbeat stop that
//   protocol spawning for CRASH_COOLDOWN_MS; its joins answer SERVER_BEHIND, and the brain logs CRASH LOOP.
// - A lobby with no heartbeat for 45 s is stopped and its port freed. An empty lobby ends after POSTGAME, or after
//   120 s empty in PREGAME (or INGAME).
// - Adoption: a restarted brain spawns nothing for 30 s (joins answer queued), adopts every lobby whose heartbeat
//   verifies under its derived key (the internal API checks the key), then stops any of its own servers (under
//   SERVERS_DIR) that never heartbeated.
// Every clock is `now()` (wall clock), injectable; no timer depends on another.

const crypto = require('crypto');
const log = require('../log');
const { signJoin, deriveLobbyKey, nowSecFrom, JOIN_TTL_SEC } = require('../auth/tokens');
const { routeProtocol, FP_RE } = require('./manifest');
const { serverArgs, childEnv } = require('./host');

const MAX_PLAYERS = 4;
const BOOT_GRACE_MS = 30 * 1000;
const HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const EMPTY_LOBBY_MS = 120 * 1000;
const SEAT_RESERVATION_MS = JOIN_TTL_SEC * 1000;
// An admitted ticket holds its seat this long for the poll that collects the token.
const ADMITTED_HOLD_MS = 15 * 1000;
// A ticket nobody polls for this long is dropped (and `expires_in_sec` says so).
const TICKET_TTL_MS = 60 * 1000;
const POLL_MS = 3000;
const BOOT_POLL_MS = 1000;
const POLL_JITTER = 0.2;
const SWEEP_MS = 1000;
// Once a minute the sweep has the host cap and prune the game servers' logs (match/host.js).
const LOG_MAINTENANCE_MS = 60 * 1000;
// The crash-loop breaker: this many lobbies of one (wire, fp) in a row that die before their first heartbeat stop that
// protocol from spawning for CRASH_COOLDOWN_MS; its players get SERVER_BEHIND meanwhile. The count is not reset by
// the cool-down, so one more early death after it trips the breaker again at once. A heartbeat resets it.
const CRASH_LOOP_LIMIT = 3;
const CRASH_COOLDOWN_MS = 10 * 60 * 1000;
const STATES = ['BOOTING', 'PREGAME', 'INGAME', 'POSTGAME'];
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_RE = /^[A-Z]{4}$/;
const SEAT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOBBY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// What a game server is told to call back on: the internal listener, on loopback.
function brainUrlFor(env) {
  return `http://127.0.0.1:${env.INTERNAL_PORT}`;
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function normalizeCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function err(code, opts = {}) {
  return { result: 'error', code, opts };
}

// env: {ENV, JOIN_KEY, LOBBY_MASTER_KEY, INTERNAL_PORT, GAME_HOST, GAME_PORTS}. manifest: {read()}. host: host.js's
// createHost() or a test double. config: () => the remote config view.
function createMatchRegistry({
  env, manifest, host, config,
  now = () => Date.now(),
  random = Math.random,
  logger = log,
  bootGraceMs = BOOT_GRACE_MS,
  crashLoopLimit = CRASH_LOOP_LIMIT,
  crashCooldownMs = CRASH_COOLDOWN_MS,
}) {
  const lobbies = new Map();
  const tickets = new Map();
  // `${wire}:${fp}` -> {early: lobbies in a row that died before their first heartbeat, blockedUntil, last}
  const crashes = new Map();
  let bootedAt = now();
  let graceDone = false;
  let sweepTimer = null;
  let lastLogMaintenance = -Infinity;
  let lock = Promise.resolve();
  const brainUrl = brainUrlFor(env);

  // Serialises everything that awaits (spawns, process listing) so two joins never take the same port.
  function locked(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  }

  const inGrace = () => now() - bootedAt < bootGraceMs;

  // --- seats -------------------------------------------------------------------------------------------------------

  function waitingFor(lobby) {
    let n = 0;
    for (const t of tickets.values()) {
      if (!t.admitted && !t.failed && t.target.type === 'lobby' && t.target.lobbyId === lobby.id) n++;
    }
    return n;
  }

  function occupancy(lobby) {
    return lobby.seats.size + lobby.bots;
  }

  function hasRoom(lobby) {
    return occupancy(lobby) < MAX_PLAYERS;
  }

  function reserve(lobby, { uid, uname }, holdMs) {
    const seat = randomId(8);
    lobby.seats.set(seat, { uid, uname, status: 'reserved', expiresAt: now() + holdMs });
    lobby.emptySince = null;
    return seat;
  }

  // One reservation per player: a new join gives up the seats this player holds but never took, and their tickets.
  function releasePlayer(uid) {
    for (const lobby of lobbies.values()) {
      for (const [seat, s] of lobby.seats) if (s.uid === uid && s.status === 'reserved') lobby.seats.delete(seat);
    }
    for (const [id, t] of tickets) if (t.uid === uid) tickets.delete(id);
  }

  function joinData(lobby, seat, { uid, uname, host: isHost }) {
    const s = lobby.seats.get(seat);
    s.expiresAt = now() + SEAT_RESERVATION_MS;
    const { token } = signJoin({
      uid, uname, lobby: lobby.id, wire: lobby.wire, fp: lobby.fp, env: env.ENV, seat, host: !!isHost,
      jti: crypto.randomBytes(12).toString('base64url'), nowSec: nowSecFrom(now()), keyHex: env.JOIN_KEY,
    });
    const data = { host: env.GAME_HOST, port: lobby.port, join_token: token };
    if (lobby.privateCode) data.private_code = lobby.privateCode;
    return data;
  }

  // --- lobbies -----------------------------------------------------------------------------------------------------

  function portHeld(port, exceptId = null) {
    for (const l of lobbies.values()) if (l.port === port && l.id !== exceptId) return true;
    return false;
  }

  async function freePort() {
    for (const p of env.GAME_PORTS) {
      if (portHeld(p)) continue;
      if (await host.portFree(p)) return p;
      logger.warn(`[match] UDP ${p} is held by something that is not a lobby; skipped`);
    }
    return null;
  }

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
      if (!findByCode(code)) return code;
    }
  }

  function findByCode(code) {
    for (const l of lobbies.values()) if (l.privateCode && l.privateCode === code) return l;
    return null;
  }

  function newLobby(fields) {
    return {
      pid: null, state: 'BOOTING', privateCode: '', seats: new Map(), bots: 0, lastHeartbeat: now(),
      heartbeated: false, adopted: false, everSeated: new Set(), emptySince: null, ...fields,
    };
  }

  // --- the crash-loop breaker --------------------------------------------------------------------------------------

  const protocolKey = (wire, fp) => `${wire}:${fp}`;

  // Whether (wire, fp) may not spawn right now. Logs once when a cool-down has run out.
  function crashBlocked(wire, fp) {
    const c = crashes.get(protocolKey(wire, fp));
    if (!c || c.blockedUntil === null) return false;
    if (now() < c.blockedUntil) return true;
    c.blockedUntil = null;
    logger.warn(`[match] crash loop: wire ${wire} fp ${fp} may spawn again after its cool-down; one more early death blocks it again`);
    return false;
  }

  // routeProtocol(), with a protocol in a crash loop answered as not deployed (SERVER_BEHIND).
  function routeFor(entries, wire, fp) {
    const r = routeProtocol(entries, { wire, fp, minWire: config().gates.min_wire });
    if (r.result === 'ok' && crashBlocked(wire, fp)) return { result: 'crash_loop' };
    return r;
  }

  // A lobby this brain spawned died before its first heartbeat (`why`: how). The limit-th in a row blocks its protocol.
  function recordEarlyDeath(lobby, why) {
    const key = protocolKey(lobby.wire, lobby.fp);
    const c = crashes.get(key) || { early: 0, blockedUntil: null, last: '' };
    c.early++;
    c.last = why;
    crashes.set(key, c);
    logger.error(`[match] lobby ${lobby.id} (wire ${lobby.wire} fp ${lobby.fp}) died before its first heartbeat: ${why} `
      + `(${c.early} in a row)`);
    if (c.early >= crashLoopLimit && c.blockedUntil === null) {
      c.blockedUntil = now() + crashCooldownMs;
      logger.error(`[match] CRASH LOOP: wire ${lobby.wire} fp ${lobby.fp}: ${c.early} lobbies in a row died before their `
        + `first heartbeat (last: ${why}). Not spawning it for ${Math.round(crashCooldownMs / 1000)} s; its players get `
        + `SERVER_BEHIND. Read its lobby logs, then fix or withdraw the binary.`);
    }
  }

  // The spawned process ended (host.start's onExit; only while this brain is the one that spawned it).
  function serverExited(lobby, code, sig) {
    return locked(async () => {
      if (lobbies.get(lobby.id) !== lobby) return;
      const how = sig ? `killed by ${sig}` : `exited with status ${code}`;
      if (!lobby.heartbeated) recordEarlyDeath(lobby, how);
      await endLobby(lobby, `its server ${how}`);
    });
  }

  // Spawns a lobby for `entry` (a manifest entry). Resolves the lobby, null when no port is free, or false when the
  // binary would not start (a missing or broken deploy: the players waiting on it are told INTERNAL rather than left
  // to retry it every second). Call under the lock.
  async function spawnLobby(entry, privateCode = '') {
    const port = await freePort();
    if (port === null) return null;
    const id = randomId(12);
    const lobby = newLobby({ id, wire: entry.wire, fp: entry.fp, port, privateCode });
    lobbies.set(id, lobby);
    const args = serverArgs({ port, lobbyId: id, netEnv: env.ENV, brainUrl, privateCode });
    const childKeys = { RJ_JOIN_KEY: env.JOIN_KEY, RJ_LOBBY_KEY: deriveLobbyKey(env.LOBBY_MASTER_KEY, id) };
    try {
      lobby.pid = await host.start({
        binary: entry.path, args, env: childEnv(childKeys), lobbyId: id,
        onExit: (code, sig) => {
          serverExited(lobby, code, sig).catch((e) => logger.error(`[match] lobby ${id} exit: ${e.message}`));
        },
      });
    } catch (e) {
      lobbies.delete(id);
      logger.error(`[match] could not start ${entry.path} for wire ${entry.wire} fp ${entry.fp}: ${e.message}`);
      return false;
    }
    logger.info(`[match] lobby ${id} spawned: wire ${entry.wire} fp ${entry.fp} UDP ${port} pid ${lobby.pid}${privateCode ? ' private' : ''}`);
    return lobby;
  }

  async function endLobby(lobby, why) {
    if (!lobbies.has(lobby.id)) return;
    lobbies.delete(lobby.id);
    logger.info(`[match] lobby ${lobby.id} ended (${why}); UDP ${lobby.port} free`);
    for (const t of tickets.values()) {
      if (t.admitted && t.admitted.lobbyId === lobby.id) t.admitted = null;
      if (!t.failed && t.target.type === 'lobby' && t.target.lobbyId === lobby.id) {
        // A player who was waiting on this lobby learns it is gone; a public player simply waits for another.
        t.failed = t.target.host ? 'INTERNAL' : 'LOBBY_NOT_FOUND';
        t.failedAt = now();
      }
    }
    try {
      await host.stop(lobby.id);
    } catch (e) {
      logger.error(`[match] stopping lobby ${lobby.id}: ${e.message}`);
    }
  }

  // The public (wire, fp) lobby a quickplay player joins: PREGAME, with room, the fullest first.
  function bestPublicLobby(wire, fp) {
    let best = null;
    for (const l of lobbies.values()) {
      if (l.privateCode || l.state !== 'PREGAME' || l.wire !== wire || l.fp !== fp || !hasRoom(l)) continue;
      if (!best || occupancy(l) > occupancy(best)) best = l;
    }
    return best;
  }

  // --- the queue ---------------------------------------------------------------------------------------------------

  function poolKey(t) {
    switch (t.target.type) {
      case 'lobby': return `lobby:${t.target.lobbyId}`;
      case 'code': return `code:${t.target.code}`;
      default: return `${t.target.type}:${t.wire}:${t.fp}`;
    }
  }

  function isWaiting(t) {
    return !t.admitted && !t.failed;
  }

  // Tickets that count against server.lobby_queue_max: everyone waiting for room, but not a player waiting for a
  // lobby that is booting (a new private lobby's creator and its first joiners).
  function cappedCount() {
    let n = 0;
    for (const t of tickets.values()) {
      if (!isWaiting(t)) continue;
      const l = t.target.type === 'lobby' ? lobbies.get(t.target.lobbyId) : null;
      if (l && l.state === 'BOOTING') continue;
      n++;
    }
    return n;
  }

  function queueFull() {
    const max = config().server.lobby_queue_max;
    return cappedCount() >= max;
  }

  function enqueue(fields) {
    const t = {
      id: `q_${crypto.randomBytes(16).toString('base64url')}`,
      kind: 'lobby', admitted: null, admittedAt: null, failed: null, failedAt: null,
      createdAt: now(), lastPoll: now(), ...fields,
    };
    tickets.set(t.id, t);
    return t;
  }

  function jittered(base) {
    return Math.round(base * (1 - POLL_JITTER + 2 * POLL_JITTER * random()));
  }

  function queuedView(t) {
    let position = 1;
    const key = poolKey(t);
    for (const o of tickets.values()) {
      if (o === t) break;
      if (isWaiting(o) && poolKey(o) === key) position++;
    }
    const l = t.target.type === 'lobby' ? lobbies.get(t.target.lobbyId) : null;
    const booting = !!l && l.state === 'BOOTING';
    let message;
    let eta;
    if (inGrace()) {
      message = 'Reconnecting to the match servers. One moment.';
      eta = Math.ceil((bootGraceMs - (now() - bootedAt)) / 1000) + 5;
    } else if (booting || t.target.type === 'create') {
      message = 'Starting a match server for you.';
      eta = 10;
    } else if (l) {
      message = 'That match is still running. You will join when it ends.';
      eta = 60;
    } else {
      message = "All the match servers are busy. You're in line.";
      eta = Math.min(600, 20 * position);
    }
    return {
      ticket: t.id, kind: t.kind, position, eta_sec: eta,
      poll_after_ms: jittered(booting || inGrace() ? BOOT_POLL_MS : POLL_MS),
      expires_in_sec: Math.round(TICKET_TTL_MS / 1000), message,
    };
  }

  function fail(t, code) {
    t.failed = code;
    t.failedAt = now();
  }

  function admit(t, lobby) {
    const seat = reserve(lobby, t, ADMITTED_HOLD_MS);
    t.admitted = { lobbyId: lobby.id, seat };
    t.admittedAt = now();
  }

  // Seats whoever can be seated, in FIFO order, and spawns what the queue needs. Call under the lock.
  async function drainLocked() {
    if (inGrace()) return;
    let entries = null;
    const readEntries = () => entries || (entries = manifest.read());
    let portsLeft = true;

    for (const t of tickets.values()) {
      if (!isWaiting(t)) continue;
      if (t.target.type === 'code') {
        const l = findByCode(t.target.code);
        if (!l) { fail(t, 'LOBBY_NOT_FOUND'); continue; }
        if (l.wire !== t.wire || l.fp !== t.fp) { fail(t, 'LOBBY_WRONG_VERSION'); continue; }
        t.target = { type: 'lobby', lobbyId: l.id, host: false };
      }
      if (t.target.type === 'lobby') {
        const l = lobbies.get(t.target.lobbyId);
        if (!l) { fail(t, t.target.host ? 'INTERNAL' : 'LOBBY_NOT_FOUND'); continue; }
        if (l.state !== 'PREGAME') continue;
        if (hasRoom(l)) admit(t, l);
        else fail(t, 'LOBBY_FULL');
      } else if (t.target.type === 'public') {
        const l = bestPublicLobby(t.wire, t.fp);
        if (l) admit(t, l);
      } else if (t.target.type === 'create' && portsLeft) {
        const route = routeFor(readEntries(), t.wire, t.fp);
        if (route.result !== 'ok') { fail(t, route.result === 'update_required' ? 'UPDATE_REQUIRED' : 'SERVER_BEHIND'); continue; }
        const l = await spawnLobby(route.entry, newCode());
        if (l === false) { fail(t, 'INTERNAL'); continue; }
        if (!l) { portsLeft = false; continue; }
        t.target = { type: 'lobby', lobbyId: l.id, host: true };
      }
    }

    // Public players still waiting, per protocol, beyond what the lobbies already booting for them will hold.
    if (!portsLeft) return;
    const need = new Map();
    for (const t of tickets.values()) {
      if (isWaiting(t) && t.target.type === 'public') {
        const k = `${t.wire}:${t.fp}`;
        need.set(k, (need.get(k) || 0) + 1);
      }
    }
    for (const l of lobbies.values()) {
      const k = `${l.wire}:${l.fp}`;
      if (!l.privateCode && l.state === 'BOOTING' && need.has(k)) need.set(k, need.get(k) - (MAX_PLAYERS - occupancy(l)));
    }
    for (const [k, n] of need) {
      const [wire, fp] = [Number(k.split(':')[0]), k.split(':')[1]];
      const route = routeFor(readEntries(), wire, fp);
      if (route.result !== 'ok') {
        for (const t of tickets.values()) {
          if (isWaiting(t) && t.target.type === 'public' && t.wire === wire && t.fp === fp) {
            fail(t, route.result === 'update_required' ? 'UPDATE_REQUIRED' : 'SERVER_BEHIND');
          }
        }
        continue;
      }
      for (let left = n; left > 0; left -= MAX_PLAYERS) {
        const l = await spawnLobby(route.entry);
        if (l === false) {
          for (const t of tickets.values()) {
            if (isWaiting(t) && t.target.type === 'public' && t.wire === wire && t.fp === fp) fail(t, 'INTERNAL');
          }
          break;
        }
        if (!l) return;
      }
    }
  }

  function drain() {
    return locked(drainLocked);
  }

  // --- the API's operations ----------------------------------------------------------------------------------------

  // POST /v1/match/join. p: {mode, code?, uid, uname, install, wire, fp}. Resolves
  // {result:'ok', data} | {result:'queued', queued} | {result:'error', code, opts}.
  function join(p) {
    return locked(async () => {
      const route = routeFor(manifest.read(), p.wire, p.fp);
      if (route.result === 'update_required') return err('UPDATE_REQUIRED', { scope: 'multiplayer' });
      releasePlayer(p.uid);
      const who = { uid: p.uid, uname: p.uname, install: p.install, wire: p.wire, fp: p.fp };

      if (p.mode === 'join_private') {
        const code = normalizeCode(p.code);
        const l = CODE_RE.test(code) ? findByCode(code) : null;
        if (!l) {
          // A restarted brain has not heard from every lobby yet: wait for the heartbeats before saying "no such lobby".
          if (inGrace() && CODE_RE.test(code)) return { result: 'queued', queued: queuedView(enqueue({ ...who, target: { type: 'code', code } })) };
          return err('LOBBY_NOT_FOUND');
        }
        if (l.wire !== p.wire || l.fp !== p.fp) return err('LOBBY_WRONG_VERSION');
        const ahead = waitingFor(l) > 0;
        if (l.state === 'PREGAME' && !ahead && !inGrace()) {
          if (!hasRoom(l)) return err('LOBBY_FULL');
          const seat = reserve(l, who, SEAT_RESERVATION_MS);
          return { result: 'ok', data: joinData(l, seat, { ...who, host: false }) };
        }
        if (l.state === 'PREGAME' && !hasRoom(l)) return err('LOBBY_FULL');
        if (l.state !== 'BOOTING' && queueFull()) return err('NO_CAPACITY');
        return { result: 'queued', queued: queuedView(enqueue({ ...who, target: { type: 'lobby', lobbyId: l.id, host: false } })) };
      }

      if (route.result !== 'ok') return err('SERVER_BEHIND');

      if (p.mode === 'create_private') {
        if (!inGrace()) {
          const l = await spawnLobby(route.entry, newCode());
          if (l === false) return err('INTERNAL');
          if (l) return { result: 'queued', queued: queuedView(enqueue({ ...who, target: { type: 'lobby', lobbyId: l.id, host: true } })) };
        }
        if (queueFull()) return err('NO_CAPACITY');
        return { result: 'queued', queued: queuedView(enqueue({ ...who, target: { type: 'create' } })) };
      }

      // quickplay
      const waiting = [...tickets.values()].some((t) => isWaiting(t) && t.target.type === 'public' && t.wire === p.wire && t.fp === p.fp);
      if (!inGrace() && !waiting) {
        const l = bestPublicLobby(p.wire, p.fp);
        if (l) {
          const seat = reserve(l, who, SEAT_RESERVATION_MS);
          return { result: 'ok', data: joinData(l, seat, { ...who, host: false }) };
        }
      }
      if (queueFull()) return err('NO_CAPACITY');
      const t = enqueue({ ...who, target: { type: 'public' } });
      await drainLocked();
      if (t.failed) {
        tickets.delete(t.id);
        return err(t.failed);
      }
      return { result: 'queued', queued: queuedView(t) };
    });
  }

  // GET /v1/queue/:ticket for a lobby ticket. Returns null when the ticket is not a lobby ticket this registry
  // knows (so another kind, M6's admission, can answer), else as join().
  function poll(ticketId, install) {
    const t = tickets.get(ticketId);
    if (!t) return null;
    if (t.install !== install) return err('QUEUE_TICKET_INVALID');
    t.lastPoll = now();
    if (t.failed) {
      tickets.delete(t.id);
      return err(t.failed);
    }
    if (t.admitted) {
      const l = lobbies.get(t.admitted.lobbyId);
      const s = l && l.seats.get(t.admitted.seat);
      if (l && s && s.uid === t.uid && s.status === 'reserved') {
        tickets.delete(t.id);
        const isHost = t.target.type === 'lobby' && t.target.host === true;
        return { result: 'ok', data: joinData(l, t.admitted.seat, { uid: t.uid, uname: t.uname, host: isHost }) };
      }
      t.admitted = null;
    }
    return { result: 'queued', queued: queuedView(t) };
  }

  // DELETE /v1/queue/:ticket. null when unknown (as poll), else ok or QUEUE_TICKET_INVALID.
  function leave(ticketId, install) {
    const t = tickets.get(ticketId);
    if (!t) return null;
    if (t.install !== install) return err('QUEUE_TICKET_INVALID');
    tickets.delete(t.id);
    if (t.admitted) {
      const l = lobbies.get(t.admitted.lobbyId);
      if (l) l.seats.delete(t.admitted.seat);
    }
    return { result: 'ok', data: {} };
  }

  // --- the internal API --------------------------------------------------------------------------------------------

  function checkHeartbeat(b) {
    const problems = [];
    if (!Number.isInteger(b.port) || !env.GAME_PORTS.includes(b.port)) problems.push('port is not one of GAME_PORTS');
    if (!Number.isInteger(b.wire) || b.wire < 1) problems.push('wire must be a positive integer');
    if (typeof b.fp !== 'string' || !FP_RE.test(b.fp)) problems.push('fp must be 16 lower-case hex characters');
    if (!STATES.includes(b.state)) problems.push(`state must be one of ${STATES.join(', ')}`);
    if (!Array.isArray(b.players) || b.players.length > MAX_PLAYERS
      || !b.players.every((x) => x && Number.isInteger(x.user_id) && x.user_id > 0 && typeof x.seat === 'string' && SEAT_RE.test(x.seat))) {
      problems.push('players must be at most 4 {user_id, seat}');
    }
    if (b.bots !== undefined && (!Number.isInteger(b.bots) || b.bots < 0 || b.bots > MAX_PLAYERS)) problems.push('bots must be 0..4');
    if (b.pid !== undefined && b.pid !== null && (!Number.isInteger(b.pid) || b.pid <= 0)) problems.push('pid must be a positive integer');
    return problems;
  }

  function reconcileSeats(lobby, players) {
    const listed = new Map(players.map((x) => [x.seat, x.user_id]));
    for (const [seat, s] of lobby.seats) {
      if (s.status === 'seated' && !listed.has(seat)) lobby.seats.delete(seat);
    }
    for (const [seat, uid] of listed) {
      const s = lobby.seats.get(seat);
      if (s && s.uid === uid) {
        s.status = 'seated';
        lobby.everSeated.add(uid);
      } else if (!s && lobby.adopted) {
        lobby.seats.set(seat, { uid, uname: '', status: 'seated', expiresAt: Infinity });
        lobby.everSeated.add(uid);
      } else {
        logger.warn(`[match] lobby ${lobby.id} reports user ${uid} in seat ${seat}, which is not theirs; ignored`);
      }
    }
  }

  // POST /internal/v1/lobby/heartbeat, after the lobby key verified. An unknown lobby is adopted.
  function heartbeat(lobbyId, b) {
    return locked(() => heartbeatLocked(lobbyId, b));
  }

  async function heartbeatLocked(lobbyId, b) {
    const problems = checkHeartbeat(b);
    if (problems.length) return err('VALIDATION', { message: `Bad heartbeat: ${problems.join('; ')}.` });
    let lobby = lobbies.get(lobbyId);
    if (!lobby) {
      if (portHeld(b.port)) {
        logger.warn(`[match] lobby ${lobbyId} heartbeats on UDP ${b.port}, which another lobby holds; not adopted`);
        return err('VALIDATION', { message: 'That port belongs to another lobby.', status: 409 });
      }
      const code = normalizeCode(b.private_code);
      lobby = newLobby({ id: lobbyId, wire: b.wire, fp: b.fp, port: b.port, state: b.state, adopted: true, privateCode: CODE_RE.test(code) ? code : '' });
      lobbies.set(lobbyId, lobby);
      logger.info(`[match] lobby ${lobbyId} adopted: wire ${b.wire} fp ${b.fp} UDP ${b.port} ${b.state}, ${b.players.length} players`);
    } else if (lobby.port !== b.port || lobby.wire !== b.wire || lobby.fp !== b.fp) {
      logger.warn(`[match] lobby ${lobbyId} heartbeat disagrees with the registry (port/wire/fp); ignored`);
      return err('VALIDATION', { message: 'That heartbeat does not match this lobby.', status: 409 });
    }
    const wasState = lobby.state;
    if (!lobby.heartbeated) {
      lobby.heartbeated = true;
      // A server of this protocol booted: whatever early deaths came before were not a loop.
      crashes.delete(protocolKey(lobby.wire, lobby.fp));
    }
    lobby.lastHeartbeat = now();
    lobby.state = b.state;
    lobby.bots = b.bots || 0;
    if (Number.isInteger(b.pid)) lobby.pid = b.pid;
    reconcileSeats(lobby, b.players);
    if (wasState !== lobby.state) logger.info(`[match] lobby ${lobbyId} ${wasState} -> ${lobby.state}`);
    if (lobby.state === 'PREGAME') await drainLocked();
    return { result: 'ok', data: {} };
  }

  function seatCheck(lobbyId, b) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return { error: err('LOBBY_NOT_FOUND', { message: 'This lobby is not registered; send a heartbeat.' }) };
    if (!b || !Number.isInteger(b.user_id) || b.user_id <= 0 || typeof b.seat !== 'string' || !SEAT_RE.test(b.seat)) {
      return { error: err('VALIDATION', { message: 'Send {user_id, seat}.' }) };
    }
    return { lobby };
  }

  // POST /internal/v1/lobby/player-joined {user_id, seat}: the seat's reservation becomes a seated player.
  function playerJoined(lobbyId, b) {
    const { lobby, error } = seatCheck(lobbyId, b);
    if (error) return error;
    const s = lobby.seats.get(b.seat);
    if (s && s.uid === b.user_id) {
      s.status = 'seated';
      s.expiresAt = Infinity;
    } else if (!s && lobby.adopted) {
      lobby.seats.set(b.seat, { uid: b.user_id, uname: '', status: 'seated', expiresAt: Infinity });
    } else {
      logger.warn(`[match] lobby ${lobbyId}: user ${b.user_id} joined seat ${b.seat}, which is not theirs`);
      return err('VALIDATION', { message: "That seat isn't this player's.", status: 409 });
    }
    lobby.everSeated.add(b.user_id);
    lobby.emptySince = null;
    return { result: 'ok', data: {} };
  }

  // POST /internal/v1/lobby/player-left {user_id, seat}: frees the seat, nothing more.
  function playerLeft(lobbyId, b) {
    return locked(async () => {
      const { lobby, error } = seatCheck(lobbyId, b);
      if (error) return error;
      const s = lobby.seats.get(b.seat);
      if (s && s.uid === b.user_id) lobby.seats.delete(b.seat);
      if (lobby.state === 'PREGAME') await drainLocked();
      return { result: 'ok', data: {} };
    });
  }

  // Whether user <uid> took a seat in lobby <lobbyId> (match results and accolades accept only those).
  function verifiedSeat(lobbyId, uid) {
    const lobby = lobbies.get(lobbyId);
    return !!lobby && lobby.everSeated.has(uid);
  }

  // --- the sweep ---------------------------------------------------------------------------------------------------

  async function sweepLocked() {
    const t = now();
    if (!graceDone && !inGrace()) {
      graceDone = true;
      const strays = (await host.ownServers()).filter((s) => !lobbies.has(s.lobbyId));
      for (const s of strays) {
        logger.warn(`[match] stopping lobby ${s.lobbyId} (pid ${s.pid}): it has not heartbeated since this brain started`);
        await host.stop(s.lobbyId);
      }
      logger.info(`[match] adoption window closed: ${lobbies.size} lobbies, ${strays.length} strays stopped`);
    }

    if (t - lastLogMaintenance >= LOG_MAINTENANCE_MS && typeof host.maintainLogs === 'function') {
      lastLogMaintenance = t;
      const r = host.maintainLogs();
      if (r && (r.rotated || r.deleted)) logger.info(`[match] server logs: ${r.rotated} capped, ${r.deleted} deleted`);
    }

    for (const lobby of [...lobbies.values()]) {
      if (t - lobby.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        // A server that hangs (or dies unseen, after a brain restart) before its first heartbeat is an early death too.
        if (!lobby.heartbeated && !lobby.adopted) recordEarlyDeath(lobby, 'no heartbeat within 45 s of its spawn');
        await endLobby(lobby, 'no heartbeat for 45 s');
        continue;
      }
      for (const [seat, s] of lobby.seats) {
        if (s.status === 'reserved' && s.expiresAt <= t) lobby.seats.delete(seat);
      }
      const humans = lobby.seats.size + waitingFor(lobby);
      if (humans > 0 || lobby.state === 'BOOTING') {
        lobby.emptySince = null;
      } else if (lobby.state === 'POSTGAME') {
        await endLobby(lobby, 'empty after POSTGAME');
      } else {
        if (lobby.emptySince === null) lobby.emptySince = t;
        if (t - lobby.emptySince >= EMPTY_LOBBY_MS) await endLobby(lobby, `empty for 120 s in ${lobby.state}`);
      }
    }

    for (const [id, tk] of tickets) {
      const lost = t - tk.lastPoll > TICKET_TTL_MS;
      if (tk.admitted) {
        const l = lobbies.get(tk.admitted.lobbyId);
        if (!l || !l.seats.has(tk.admitted.seat)) tk.admitted = null;
      }
      if (lost) {
        if (tk.admitted) {
          const l = lobbies.get(tk.admitted.lobbyId);
          if (l) l.seats.delete(tk.admitted.seat);
        }
        tickets.delete(id);
      }
    }
    await drainLocked();
  }

  function sweep() {
    return locked(sweepLocked);
  }

  return {
    join, poll, leave, heartbeat, playerJoined, playerLeft, verifiedSeat, sweep, drain,
    inGrace,
    start() {
      bootedAt = now();
      graceDone = false;
      if (!sweepTimer) {
        sweepTimer = setInterval(() => {
          sweep().catch((e) => logger.error('[match] sweep failed:', e));
        }, SWEEP_MS);
      }
    },
    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
    // Tests and diagnostics.
    get lobbies() { return lobbies; },
    get tickets() { return tickets; },
    get crashes() { return crashes; },
  };
}

module.exports = {
  createMatchRegistry, brainUrlFor, MAX_PLAYERS, BOOT_GRACE_MS, HEARTBEAT_TIMEOUT_MS, EMPTY_LOBBY_MS, SEAT_RESERVATION_MS,
  ADMITTED_HOLD_MS, TICKET_TTL_MS, POLL_MS, BOOT_POLL_MS, LOBBY_ID_RE, CODE_RE, CRASH_LOOP_LIMIT, CRASH_COOLDOWN_MS,
};
