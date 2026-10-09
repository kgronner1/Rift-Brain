// Bootstrap: the environment, the database, the lobby registry and the listeners.
// Every value that differs between the legacy brain, dev and alpha comes from config/env.js.

const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');

const log = require('./log');
const { loadEnv } = require('./config/env');
const { createRemoteConfig } = require('./config/remote');
const { createV1Router } = require('./routes/v1');
const { createAdmission } = require('./admission/admission');
const { initDB, connectDB } = require('./db');
const { createLobbyRegistry } = require('./match/lobbies');
const { createMatchRegistry, brainUrlFor } = require('./match/registry');
const { createManifestReader } = require('./match/manifest');
const { createHost } = require('./match/host');
const { registerLobbyRoutes, registerProbeRoutes } = require('./routes/legacy/lobby');
const { createInternalRouter } = require('./routes/internal');
const { registerStorageRoutes } = require('./routes/legacy/storage');

// Ensure fatal errors have a dedicated log file outside stdout/stderr.
const fatalLogDir = path.join(__dirname, '..', 'logs');
const fatalLogPath = path.join(fatalLogDir, 'fatal.log');

// Central helper to persist fatal errors with context and stack traces.
function logFatalError(err, context) {
  const timestamp = new Date().toISOString();
  const details = log.redactString(err && err.stack ? err.stack : String(err));
  const line = `[${timestamp}] ${context}\n${details}\n`;
  fs.appendFile(fatalLogPath, line, (writeErr) => {
    if (writeErr) {
      log.error('Failed to write fatal log:', writeErr);
    }
  });
}

// The public app: /v1 (RJ 465) when `v1` is given, and today's routes, unchanged. Takes the registry so tests can
// drive it without a database. v1: {env, remote, now?, match?} (routes/v1/index.js).
// lobbies: the legacy registry (match/lobbies.js), whose matchmaking routes only the legacy brain serves; null in a new
// environment, which matches through /v1/match/join (M4) and keeps only the two probes (GET / and
// /server_health_check) of today's lobby routes.
function createPublicApp(lobbies, { v1 } = {}) {
  const app = express();
  // Caddy on the same box is the only proxy: req.ip is the client's address behind it (spec 4.9).
  app.set('trust proxy', 'loopback');
  if (v1) app.use('/v1', createV1Router(v1));
  app.use(express.json());
  // Keep request logging minimal and low overhead; through log.js, like every other line.
  app.use(morgan('tiny', { stream: log.stream }));

  if (lobbies) registerLobbyRoutes(app, lobbies);
  else registerProbeRoutes(app);
  registerStorageRoutes(app);

  // Treat unexpected route errors as fatal and return a safe 500 response.
  app.use(function (err, req, res, next) {
    logFatalError(err, `express ${req.method} ${req.originalUrl}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// The internal app (game server -> brain, 127.0.0.1 only; spec 4.11). internal: {env, match, config?, store?}.
function createInternalApp(internal) {
  const app = express();
  if (internal) app.use('/internal/v1', createInternalRouter(internal));
  return app;
}

function listen(app, port, host, name) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      log.info(`Rift brain ${name} listener on ${host || '*'}:${port}`);
      resolve(server);
    };
    const server = host ? app.listen(port, host, onListening) : app.listen(port, onListening);
    server.on('error', reject);
  });
}

async function main() {
  require('dotenv').config();

  fs.mkdirSync(fatalLogDir, { recursive: true });

  // Capture process-level failures so they are recorded as fatal.
  process.on('uncaughtException', (err) => {
    logFatalError(err, 'uncaughtException');
  });

  process.on('unhandledRejection', (err) => {
    logFatalError(err, 'unhandledRejection');
  });

  let env;
  try {
    env = loadEnv(process.env);
  } catch (err) {
    log.error(err.message);
    logFatalError(err, 'boot: environment');
    process.exitCode = 1;
    return;
  }
  log.info(`Rift brain ENV=${env.ENV}`);

  initDB(env.MYSQL);
  await connectDB();

  // The legacy brain: today's routes and registry, unchanged.
  if (env.ENV === 'legacy') {
    const lobbies = createLobbyRegistry({ ports: env.GAME_PORTS, serverBinary: env.SERVER_BINARY });
    lobbies.start();
    await listen(createPublicApp(lobbies), env.PUBLIC_PORT, env.BIND_HOST, 'public');
    if (env.INTERNAL_PORT !== null) await listen(createInternalApp(null), env.INTERNAL_PORT, '127.0.0.1', 'internal');
    return;
  }

  // A new environment: /v1 with its remote config's gates, and matchmaking per wire protocol (M4).
  const remote = createRemoteConfig({ env: env.ENV, url: env.CONFIG_URL });
  await remote.start();
  const config = () => remote.current();
  const match = createMatchRegistry({
    env,
    manifest: createManifestReader(env.SERVERS_DIR),
    host: createHost({ serversDir: env.SERVERS_DIR, brainUrl: brainUrlFor(env), logDir: env.SERVER_LOGS_DIR }),
    config,
  });
  // The internal listener first: lobbies that outlived the last brain heartbeat into it from the first moment.
  await listen(createInternalApp({ env, match, config }), env.INTERNAL_PORT, '127.0.0.1', 'internal');
  match.start();
  const admission = createAdmission({ env, config });
  admission.start();
  await listen(createPublicApp(null, { v1: { env, remote, match, admission } }), env.PUBLIC_PORT, env.BIND_HOST, 'public');
}

if (require.main === module) {
  main();
}

module.exports = { createPublicApp, createInternalApp, main };
