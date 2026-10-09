'use strict';
// The box side of a lobby (spec M4): is a UDP port free, start a game server, find and stop one. The registry takes
// these as one injectable object, so its tests never touch a port or a process.
//
// A game server is started with
//   <binary> --port=<p> --lobby_id=<id> --net_env=<env> --brain_url=http://127.0.0.1:<INTERNAL_PORT> [--private_code=<c>]
// and RJ_JOIN_KEY / RJ_LOBBY_KEY in its environment, never in argv (argv is world-readable in ps). The child gets a
// minimal environment: none of the brain's own secrets (SESSION_KEY, MYSQL_PASSWORD, LOBBY_MASTER_KEY) reach it.

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const log = require('../log');

// What a game server inherits from the brain's environment, besides its two keys.
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'];

// Resolves true when nothing holds UDP <port> (ENet binds every interface, so the test does too).
function udpPortFree(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => {
      try { s.close(); } catch (e) { /* already closed */ }
      resolve(false);
    });
    s.bind({ port, address: '0.0.0.0', exclusive: true }, () => s.close(() => resolve(true)));
  });
}

function childEnv(keys, source = process.env) {
  const env = {};
  for (const k of PASSED_ENV) if (source[k] !== undefined) env[k] = source[k];
  return { ...env, ...keys };
}

// argv for a game server. Pure.
function serverArgs({ port, lobbyId, netEnv, brainUrl, privateCode }) {
  const args = [`--port=${port}`, `--lobby_id=${lobbyId}`, `--net_env=${netEnv}`, `--brain_url=${brainUrl}`];
  if (privateCode) args.push(`--private_code=${privateCode}`);
  return args;
}

// The game server is started through /bin/sh, which sets RLIMIT_CORE to 0 (soft and hard) and execs it: the same pid
// and command line, and no core dump. A crash-looping server once wrote a ~21 MB core every 45 s on the shared box
// (2026-10-09). Node has no rlimit option for spawn(), on Node 20 or since.
const NO_CORE_WRAPPER = ['-c', 'ulimit -c 0 && exec "$0" "$@"'];

// [command, argv] that runs <binary> <args> with no core dump. Pure.
function noCoreCommand(binary, args) {
  return ['/bin/sh', [...NO_CORE_WRAPPER, binary, ...args]];
}

// Starts one game server, detached (pm2 runs the brain with treekill: false, so a brain restart leaves it running).
// logFile: optional; stdout and stderr are appended there, else discarded. onExit(code, signal): optional, called once
// when the process ends, if this brain is still running then. Resolves the pid.
function startServer({ binary, args, env, logFile = null, onExit = null }) {
  return new Promise((resolve, reject) => {
    let out = 'ignore';
    if (logFile) {
      try {
        out = fs.openSync(logFile, 'a', 0o600);
      } catch (e) {
        log.warn(`[host] cannot open ${logFile}: ${e.message}; the server's output is discarded`);
      }
    }
    let child;
    try {
      // The wrapper would start even with no binary to exec: refuse a missing or non-executable one here, as spawn() did.
      fs.accessSync(binary, fs.constants.X_OK);
      const [command, argv] = noCoreCommand(binary, args);
      child = spawn(command, argv, { detached: true, stdio: ['ignore', out, out], env, cwd: path.dirname(binary) });
    } catch (e) {
      reject(e);
      return;
    } finally {
      if (typeof out === 'number') fs.closeSync(out);
    }
    child.once('error', reject);
    if (!child.pid) return;
    if (onExit) child.once('exit', (code, sig) => onExit(code, sig));
    child.unref();
    resolve(child.pid);
  });
}

// Every process on the box: [{pid, args}] (`ps -eo pid=,args=`, on Linux and macOS alike).
function listProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.error(`[host] ps failed: ${err.message}`);
        resolve([]);
        return;
      }
      const out = [];
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) out.push({ pid: Number(m[1]), args: m[2] });
      }
      resolve(out);
    });
  });
}

// The game servers this environment started: a process whose command line carries --lobby_id= and either runs a
// binary under serversDir or names this brain's --brain_url (a wrapper that execs another binary, as a local stack
// test does, keeps only its arguments). Pure over the process list. -> [{pid, lobbyId, args}]
function ownServers(processes, serversDir, brainUrl = null) {
  const prefix = serversDir.endsWith('/') ? serversDir : `${serversDir}/`;
  const brainArg = brainUrl ? `--brain_url=${brainUrl}` : null;
  const out = [];
  for (const p of processes) {
    const words = p.args.split(/\s+/);
    if (!p.args.includes(prefix) && !(brainArg && words.includes(brainArg))) continue;
    const m = p.args.match(/(?:^|\s)--lobby_id=([A-Za-z0-9_-]+)(?:\s|$)/);
    if (m) out.push({ pid: p.pid, lobbyId: m[1], args: p.args });
  }
  return out;
}

function signal(pid, sig = 'SIGTERM') {
  try {
    process.kill(pid, sig);
    return true;
  } catch (e) {
    if (e.code !== 'ESRCH') log.warn(`[host] kill ${pid}: ${e.message}`);
    return false;
  }
}

// --- the per-lobby logs ------------------------------------------------------------------------------------------
// Each game server's stdout and stderr go to <logDir>/lobby-<id>.log, opened for append. The brain caps them: a log
// past maxBytes is copied to lobby-<id>.log.1 and truncated in place (copytruncate: the server keeps writing to the
// same file, and O_APPEND puts its next line at the new end), so one lobby holds at most twice maxBytes. Logs older
// than maxAgeMs, and all but the newest maxFiles lobbies, are deleted.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_MAX_FILES = 200;
const LOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const LOG_RE = /^lobby-[A-Za-z0-9_-]+\.log(\.1)?$/;

// Caps and prunes logDir. Never throws; resolves {rotated, deleted} counts.
function maintainLogs(logDir, { maxBytes = LOG_MAX_BYTES, maxFiles = LOG_MAX_FILES, maxAgeMs = LOG_MAX_AGE_MS, now = Date.now() } = {}) {
  const out = { rotated: 0, deleted: 0 };
  let names;
  try {
    names = fs.readdirSync(logDir).filter((n) => LOG_RE.test(n));
  } catch (e) {
    return out;
  }
  const lobbies = new Map();
  for (const n of names) {
    const file = path.join(logDir, n);
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    const id = n.replace(/\.log(\.1)?$/, '');
    const l = lobbies.get(id) || { files: [], mtime: 0 };
    l.files.push(file);
    l.mtime = Math.max(l.mtime, st.mtimeMs);
    lobbies.set(id, l);
    if (!n.endsWith('.log') || st.size <= maxBytes) continue;
    try {
      fs.copyFileSync(file, `${file}.1`);
      fs.truncateSync(file, 0);
      out.rotated++;
    } catch (e) {
      log.warn(`[host] cannot cap ${file}: ${e.message}`);
    }
  }
  const byAge = [...lobbies.values()].sort((a, b) => b.mtime - a.mtime);
  byAge.forEach((l, i) => {
    if (i < maxFiles && now - l.mtime <= maxAgeMs) return;
    for (const f of l.files) {
      try { fs.unlinkSync(f); out.deleted++; } catch (e) { /* gone already */ }
    }
  });
  return out;
}

// The real box. serversDir and brainUrl scope which processes are ours: nothing else is ever signalled.
function createHost({ serversDir, brainUrl = null, logDir = null, logLimits = {} }) {
  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o750 });
    } catch (e) {
      log.warn(`[host] cannot create SERVER_LOGS_DIR ${logDir}: ${e.message}; game servers' output is discarded`);
    }
  }
  return {
    portFree: udpPortFree,
    start({ binary, args, env, lobbyId, onExit = null }) {
      const logFile = logDir ? path.join(logDir, `lobby-${lobbyId}.log`) : null;
      return startServer({ binary, args, env, logFile, onExit });
    },
    // Called from the registry's sweep, at most once a minute.
    maintainLogs() {
      return logDir ? maintainLogs(logDir, logLimits) : { rotated: 0, deleted: 0 };
    },
    logFile(lobbyId) {
      return logDir ? path.join(logDir, `lobby-${lobbyId}.log`) : null;
    },
    async ownServers() {
      return ownServers(await listProcesses(), serversDir, brainUrl);
    },
    // Stops lobby <lobbyId>'s process, found by its command line under serversDir, never by a pid alone: a stale or
    // wrong pid (an adopted lobby's heartbeat names its own) can never stop anything else.
    async stop(lobbyId) {
      const mine = (await this.ownServers()).filter((s) => s.lobbyId === lobbyId);
      for (const s of mine) signal(s.pid);
      return mine.length;
    },
  };
}

module.exports = {
  createHost, udpPortFree, childEnv, serverArgs, startServer, listProcesses, ownServers, noCoreCommand, maintainLogs,
  PASSED_ENV, LOG_MAX_BYTES, LOG_MAX_FILES, LOG_MAX_AGE_MS,
};
