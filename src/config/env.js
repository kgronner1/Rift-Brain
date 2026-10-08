'use strict';

// The brain's whole configuration comes from its environment (.env on the box), validated once at boot,
// so the same code runs as the legacy brain (ENV unset) and as dev or alpha.

const ENVS = ['legacy', 'dev', 'alpha', 'prod'];

// ENV unset is the legacy brain: everything defaults to what the code hardcoded before RJ 462, so an
// untouched legacy .env (MYSQL_* only) keeps today's behaviour.
const LEGACY_DEFAULTS = {
  PUBLIC_PORT: '3000',
  GAME_PORTS: '8080-8085',
  SERVER_BINARY: '/home/ec2-user/rift_jumper_multiplayer_server_test.x86_64',
};

const KEY_NAMES = ['SESSION_KEY', 'JOIN_KEY', 'LOBBY_MASTER_KEY'];

class EnvError extends Error {
  constructor(problems) {
    super(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function parsePort(name, value, problems) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) {
    problems.push(`${name} must be a port number, got "${value}"`);
    return null;
  }
  const n = Number(s);
  if (n < 1 || n > 65535) {
    problems.push(`${name} must be in 1..65535, got ${n}`);
    return null;
  }
  return n;
}

// "8080-8085", "8080,8081,8090-8092" -> [8080, ...] in the order written, duplicates refused.
function parsePortList(name, value, problems) {
  const ports = [];
  for (const part of String(value).split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = parsePort(name, range[1], problems);
      const hi = parsePort(name, range[2], problems);
      if (lo === null || hi === null) continue;
      if (hi < lo) {
        problems.push(`${name} range "${part}" runs backwards`);
        continue;
      }
      for (let p = lo; p <= hi; p++) ports.push(p);
    } else {
      const p = parsePort(name, part, problems);
      if (p !== null) ports.push(p);
    }
  }
  if (ports.length === 0) problems.push(`${name} names no ports`);
  if (new Set(ports).size !== ports.length) problems.push(`${name} names a port twice`);
  return ports;
}

// MYSQL_* alone: what src/migrate.js needs, and part of what the brain needs.
function readMysql(raw, problems) {
  for (const name of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_DATABASE']) {
    if (isBlank(raw[name])) problems.push(`${name} is required`);
  }
  if (raw.MYSQL_PASSWORD === undefined) problems.push('MYSQL_PASSWORD is required (it may be empty)');
  const mysql = {
    host: raw.MYSQL_HOST,
    user: raw.MYSQL_USER,
    password: raw.MYSQL_PASSWORD,
    database: raw.MYSQL_DATABASE,
  };
  if (!isBlank(raw.MYSQL_PORT)) mysql.port = parsePort('MYSQL_PORT', raw.MYSQL_PORT, problems);
  return mysql;
}

function loadMysqlEnv(raw = process.env) {
  const problems = [];
  const mysql = readMysql(raw, problems);
  if (problems.length) throw new EnvError(problems);
  return Object.freeze(mysql);
}

function loadEnv(raw = process.env) {
  const problems = [];
  const env = isBlank(raw.ENV) ? 'legacy' : String(raw.ENV).trim();
  if (!ENVS.includes(env)) problems.push(`ENV must be one of ${ENVS.join(', ')}, got "${env}"`);
  const legacy = env === 'legacy';

  const pick = (name) => {
    if (!isBlank(raw[name])) return String(raw[name]).trim();
    return legacy ? LEGACY_DEFAULTS[name] : undefined;
  };

  // A new environment spells its ports out, so it can never default onto the legacy brain's.
  for (const name of ['PUBLIC_PORT', 'GAME_PORTS', 'SERVER_BINARY']) {
    if (pick(name) === undefined) problems.push(`${name} is required when ENV=${env}`);
  }

  const publicPortRaw = pick('PUBLIC_PORT');
  const publicPort = publicPortRaw === undefined ? null : parsePort('PUBLIC_PORT', publicPortRaw, problems);
  const internalPort = isBlank(raw.INTERNAL_PORT) ? null : parsePort('INTERNAL_PORT', raw.INTERNAL_PORT, problems);
  if (publicPort !== null && internalPort !== null && publicPort === internalPort) {
    problems.push('INTERNAL_PORT must differ from PUBLIC_PORT');
  }

  const gamePortsRaw = pick('GAME_PORTS');
  const gamePorts = gamePortsRaw === undefined ? [] : parsePortList('GAME_PORTS', gamePortsRaw, problems);
  for (const p of [publicPort, internalPort]) {
    if (p !== null && gamePorts.includes(p)) problems.push(`GAME_PORTS must not include the brain's own port ${p}`);
  }

  const keys = {};
  for (const name of KEY_NAMES) {
    if (isBlank(raw[name])) {
      keys[name] = null;
      continue;
    }
    const v = String(raw[name]).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(v)) problems.push(`${name} must be 64 hex characters (32 bytes, openssl rand -hex 32)`);
    keys[name] = v.toLowerCase();
  }

  // /v1 signs sessions with it (RJ 465): a new environment cannot serve without one.
  if (!legacy && keys.SESSION_KEY === null) problems.push(`SESSION_KEY is required when ENV=${env}`);

  let configUrl = null;
  if (!isBlank(raw.CONFIG_URL)) {
    try {
      const u = new URL(String(raw.CONFIG_URL).trim());
      if (u.protocol !== 'https:') problems.push('CONFIG_URL must be https');
      configUrl = u.toString();
    } catch (e) {
      problems.push(`CONFIG_URL is not a URL: "${raw.CONFIG_URL}"`);
    }
  }

  const mysql = readMysql(raw, problems);

  if (problems.length) throw new EnvError(problems);

  return Object.freeze({
    ENV: env,
    // null: every interface, as app.listen(port) did before RJ 462. Only the legacy brain gets it by default.
    BIND_HOST: !isBlank(raw.BIND_HOST) ? String(raw.BIND_HOST).trim() : (legacy ? null : '127.0.0.1'),
    PUBLIC_PORT: publicPort,
    INTERNAL_PORT: internalPort,
    MYSQL: Object.freeze(mysql),
    SESSION_KEY: keys.SESSION_KEY,
    JOIN_KEY: keys.JOIN_KEY,
    LOBBY_MASTER_KEY: keys.LOBBY_MASTER_KEY,
    GAME_HOST: isBlank(raw.GAME_HOST) ? null : String(raw.GAME_HOST).trim(),
    GAME_PORTS: Object.freeze(gamePorts),
    SERVER_BINARY: pick('SERVER_BINARY'),
    SERVERS_DIR: isBlank(raw.SERVERS_DIR) ? null : String(raw.SERVERS_DIR).trim(),
    CONFIG_URL: configUrl,
  });
}

module.exports = { loadEnv, loadMysqlEnv, EnvError, ENVS, LEGACY_DEFAULTS };
