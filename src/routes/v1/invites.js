'use strict';
// Invite links (RJ 458, phase A; Wobble Planet specs/invite-links.md, 2.1, 2.2, 2.5):
//   POST /v1/me/invites   🔒  {}  -> {invite: {id, url, expires_in}}
//   GET  /v1/invites/:id  public -> {valid: true, inviter: {username}, expires_in} | {valid: false}
//
// The mint, in order: the session; VALIDATION while flags.invites is off (the brain's own kill switch, as guest_play's);
// RATE_LIMITED, 30 an hour per account (bucket invite-mint-uid, a fixed window from the first mint); AUTH_INVALID when
// the account is gone. Every call mints a new id; guests may mint (gap-fill: they are real accounts). The url is the
// brain's JOIN_URL_BASE + "/" + id: the client never builds one. Not a multiplayer route (gap-fill): the multiplayer
// floor and multiplayer maintenance do not stop a share.
//
// The lookup is mounted ahead of the client-header gates (routes/v1/index.js): a browser calls it, with no X-RJ
// headers, from the link's page. In order: RATE_LIMITED, 60 a minute per IP (bucket invite-lookup-ip); then
// {valid: false} for an id that is unknown, expired, malformed or whose inviter was deleted, all alike. It answers
// while flags.invites is off (gap-fill), so a page already open still names the inviter. CORS allows only the link
// page's origins (JOIN_PAGE_ORIGINS; by default JOIN_URL_BASE's own), for GET and its preflight; `Cache-Control:
// no-store`. The id is kept out of the request's log line (middleware/requestId.js): anyone holding it can follow the
// inviter for a day.

const { fail, sendOk } = require('../../contract/envelope');
const log = require('../../log');
const storage = require('../../storage/invites');
const { route } = require('./util');

const MINT_PER_HOUR = 30;
const LOOKUP_PER_MIN = 60;
const HOUR_MS = 60 * 60 * 1000;
const INVITES_OFF = 'Invites are off right now. Share your lobby code instead.';

// The origins the lookup's CORS allows: JOIN_PAGE_ORIGINS (config/env.js), else JOIN_URL_BASE's own.
function pageOrigins(env) {
  if (Array.isArray(env.JOIN_PAGE_ORIGINS)) return env.JOIN_PAGE_ORIGINS;
  try {
    return env.JOIN_URL_BASE ? [new URL(env.JOIN_URL_BASE).origin] : [];
  } catch (e) {
    return [];
  }
}

function invitesOn(config) {
  return config().flags.invites === true;
}

// invites: {mintInvite(uid, {now}), findInvite(id, {now})} (storage/invites.js); tests pass their own.
function registerInviteRoutes(router, { env, config, now, limiter, rateLimited, requireSession, invites = storage }) {
  router.post('/me/invites', requireSession, route(async (req, res) => {
    const uid = req.session.uid;
    if (!invitesOn(config)) fail('VALIDATION', { message: INVITES_OFF });
    if (!env.JOIN_URL_BASE) {
      log.error(`[invites] ${req.ref} JOIN_URL_BASE is not set for ENV=${env.ENV}: no invite can be minted`);
      fail('INTERNAL');
    }
    rateLimited(limiter.hit('invite-mint-uid', String(uid), MINT_PER_HOUR, HOUR_MS));
    const invite = await invites.mintInvite(uid, { now: now() });
    if (!invite) fail('AUTH_INVALID');
    sendOk(res, { invite: { id: invite.id, url: `${env.JOIN_URL_BASE}/${invite.id}`, expires_in: invite.expires_in } });
  }));
}

// The public half: register before clientHeaders.
function registerPublicInviteRoutes(router, { env, now, limiter, rateLimited, invites = storage }) {
  const origins = pageOrigins(env);

  function cors(req, res) {
    res.setHeader('Vary', 'Origin');
    const origin = req.get('Origin');
    if (typeof origin === 'string' && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  router.options('/invites/:id', (req, res) => {
    cors(req, res);
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.status(204).end();
  });

  router.get('/invites/:id', route(async (req, res) => {
    cors(req, res);
    res.setHeader('Cache-Control', 'no-store');
    rateLimited(limiter.hit('invite-lookup-ip', req.ip, LOOKUP_PER_MIN));
    const id = storage.normalizeInviteId(req.params.id);
    const invite = id ? await invites.findInvite(id, { now: now() }) : null;
    if (!invite) {
      sendOk(res, { valid: false });
      return;
    }
    sendOk(res, { valid: true, inviter: { username: invite.username }, expires_in: invite.expires_in });
  }));
}

module.exports = { registerInviteRoutes, registerPublicInviteRoutes, pageOrigins, INVITES_OFF, MINT_PER_HOUR, LOOKUP_PER_MIN };
