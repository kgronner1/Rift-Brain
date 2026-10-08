'use strict';
// Shared by the M4 tests: a match registry over a fake box (no ports, no processes) and a settable clock.
const { createMatchRegistry } = require('../src/match/registry');
const { defaultView } = require('../src/config/remote');
const { deriveLobbyKey } = require('../src/auth/tokens');

const JOIN_KEY = '1a'.repeat(32);
const LOBBY_MASTER_KEY = '2b'.repeat(32);
const SESSION_KEY = '3c'.repeat(32);
const FP_A = '9f2c4e1a0b7d3c55';
const FP_B = '0123456789abcdef';
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const ENV = Object.freeze({
  ENV: 'dev', JOIN_KEY, LOBBY_MASTER_KEY, SESSION_KEY, INTERNAL_PORT: 3101, GAME_HOST: 'play.example.test',
  GAME_PORTS: Object.freeze([8100, 8101, 8102]),
});

function manifestEntry(wire, fp, status = 'active') {
  return { wire, fp, path: `/srv/wire-${wire}-${fp}/server.x86_64`, sha: 'abc', deployed_at: '', status };
}

// The box: which ports are busy, what was started and stopped, and which of "our" processes are running.
function fakeHost() {
  let nextPid = 5000;
  const h = {
    started: [],
    stopped: [],
    busy: new Set(),
    running: new Map(),
    async portFree(p) { return !h.busy.has(p); },
    async start({ binary, args, env, lobbyId }) {
      const pid = nextPid++;
      h.started.push({ binary, args, env, lobbyId, pid });
      h.running.set(lobbyId, pid);
      return pid;
    },
    async ownServers() { return [...h.running].map(([lobbyId, pid]) => ({ lobbyId, pid, args: '' })); },
    async stop(lobbyId) {
      h.stopped.push(lobbyId);
      h.running.delete(lobbyId);
      return 1;
    },
  };
  return h;
}

function quietLogger() {
  const lines = [];
  const add = (...a) => lines.push(a.join(' '));
  return { lines, info: add, warn: add, error: add };
}

// opts: entries, view patch fn, bootGraceMs (0 by default: most tests start past the adoption window), host, clock.
function makeRegistry(opts = {}) {
  const clock = opts.clock || { t: T0 };
  const host = opts.host || fakeHost();
  const view = opts.view || defaultView('dev');
  const manifest = { entries: opts.entries || [manifestEntry(17, FP_A)], read() { return this.entries; } };
  const logger = opts.logger || quietLogger();
  const reg = createMatchRegistry({
    env: ENV, manifest, host, config: () => view, now: () => clock.t, logger,
    bootGraceMs: opts.bootGraceMs === undefined ? 0 : opts.bootGraceMs,
    random: opts.random || Math.random,
  });
  return { reg, host, view, manifest, clock, logger, advance: (ms) => { clock.t += ms; } };
}

let nextUid = 100;
function player(extra = {}) {
  const uid = nextUid++;
  return { mode: 'quickplay', uid, uname: `pilot${uid}`, install: `install-${uid}`, wire: 17, fp: FP_A, ...extra };
}

// The heartbeat a lobby's game server would send.
function beat(lobby, state, { players, bots = 0, pid } = {}) {
  const seated = players || [...lobby.seats].filter(([, s]) => s.status === 'seated').map(([seat, s]) => ({ user_id: s.uid, seat }));
  return {
    port: lobby.port, wire: lobby.wire, fp: lobby.fp, state, players: seated, bots,
    private_code: lobby.privateCode || '', pid: pid === undefined ? lobby.pid : pid,
  };
}

function lobbyKey(id) {
  return deriveLobbyKey(LOBBY_MASTER_KEY, id);
}

module.exports = {
  JOIN_KEY, LOBBY_MASTER_KEY, SESSION_KEY, FP_A, FP_B, T0, ENV,
  manifestEntry, fakeHost, quietLogger, makeRegistry, player, beat, lobbyKey,
};
