'use strict';
// The single HTTP enforcement point for the client's headers (spec 4.9). In order, the first that fails answers:
//   1. X-RJ-Env != the brain's env                                  -> ENV_MISMATCH
//   2. X-RJ-Api outside [API_MIN, API_MAX]                          -> API_UNSUPPORTED
//   3. X-RJ-Build < gates.min_build[platform]                      -> UPDATE_REQUIRED, scope app
//   4. multiplayer route and build < gates.min_build_multiplayer   -> UPDATE_REQUIRED, scope multiplayer
//   5. gates.maintenance.active: every route for scope app, multiplayer routes for scope multiplayer -> MAINTENANCE
// Runs before the body is parsed and before auth, so a build that may not talk to us learns why first.
//
// A missing or unparseable X-RJ-Build counts as build 0: it passes a floor of 0 and nothing higher.

const { fail } = require('../contract/envelope');
const { floorFor } = require('../config/remoteSchema');

const API_MIN = 1;
const API_MAX = 1;

// The multiplayer (gamepad) routes of spec 4.10, relative to /v1: gates 4 and 5 apply to them.
const MULTIPLAYER_ROUTES = Object.freeze([{ method: 'POST', path: '/match/join' }]);

function isMultiplayerRoute(req, routes = MULTIPLAYER_ROUTES) {
  const path = req.path.replace(/\/+$/, '') || '/';
  return routes.some((r) => r.method === req.method && r.path === path);
}

function parseIntHeader(v) {
  if (typeof v !== 'string' || !/^\s*\d{1,15}\s*$/.test(v)) return null;
  return Number(v.trim());
}

// What a client's headers say, cleaned. Platform is lower case; unknown platforms read the gates' default.
function readClientHeaders(req) {
  const build = parseIntHeader(req.get('X-RJ-Build'));
  return {
    env: (req.get('X-RJ-Env') || '').trim(),
    api: parseIntHeader(req.get('X-RJ-Api')),
    build: build === null ? 0 : build,
    platform: (req.get('X-RJ-Platform') || '').trim().toLowerCase(),
    install: (req.get('X-RJ-Install') || '').trim(),
    wire: parseIntHeader(req.get('X-RJ-Wire')),
    fp: (req.get('X-RJ-Wire-Fp') || '').trim(),
  };
}

function maintenanceRetry(maintenance, nowMs) {
  const endsAt = maintenance.ends_at ? Date.parse(maintenance.ends_at) : NaN;
  if (Number.isNaN(endsAt)) return { kind: 'backoff' };
  return { kind: 'after', after_ms: Math.max(0, endsAt - nowMs) };
}

// The check itself, pure over (headers, config view): returns null or [code, opts].
function checkClient(client, { serverEnv, view, multiplayer, nowMs }) {
  if (client.env !== serverEnv) return ['ENV_MISMATCH', {}];
  if (client.api === null || client.api < API_MIN || client.api > API_MAX) return ['API_UNSUPPORTED', {}];
  const gates = view.gates;
  if (client.build < floorFor(gates.min_build, client.platform)) {
    return ['UPDATE_REQUIRED', { scope: 'app' }];
  }
  if (multiplayer && client.build < floorFor(gates.min_build_multiplayer, client.platform)) {
    return ['UPDATE_REQUIRED', { scope: 'multiplayer' }];
  }
  const m = gates.maintenance;
  if (m && m.active === true && (m.scope === 'app' || multiplayer)) {
    const opts = { scope: m.scope === 'app' ? 'app' : 'multiplayer', retry: maintenanceRetry(m, nowMs) };
    if (typeof m.message === 'string' && m.message.trim() !== '') opts.message = m.message;
    if (typeof m.title === 'string' && m.title.trim() !== '') opts.title = m.title;
    return ['MAINTENANCE', opts];
  }
  return null;
}

// config: () => the remote config view (config/remote.js). serverEnv: the brain's ENV.
function clientHeaders({ serverEnv, config, now = () => Date.now(), multiplayerRoutes = MULTIPLAYER_ROUTES }) {
  return function clientHeadersMiddleware(req, res, next) {
    const client = readClientHeaders(req);
    req.client = client;
    const failure = checkClient(client, {
      serverEnv,
      view: config(),
      multiplayer: isMultiplayerRoute(req, multiplayerRoutes),
      nowMs: now(),
    });
    if (!failure) return next();
    try {
      fail(failure[0], failure[1]);
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { clientHeaders, checkClient, readClientHeaders, isMultiplayerRoute, MULTIPLAYER_ROUTES, API_MIN, API_MAX };
