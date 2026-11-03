'use strict';
// Matchmaking (spec 4.10, M4):
//   POST   /v1/match/join     🔒🎮 {mode: quickplay|create_private|join_private|join_user, code?, invite?}
//            ok {host, port, join_token, private_code?} | queued (kind lobby, or follow) | LOBBY_NOT_FOUND | LOBBY_FULL |
//            LOBBY_WRONG_VERSION | NO_CAPACITY | UPDATE_REQUIRED | SERVER_BEHIND | MAINTENANCE (clientHeaders) |
//            INVITE_INVALID (join_user)
// join_user (RJ 458; Wobble Planet specs/invite-links.md, 2.3), in order: VALIDATION while flags.invites is off, or
// with no `invite` string; AUTH_INVALID for a gone caller; INVITE_INVALID for an invite unknown, expired or malformed;
// VALIDATION for the caller's own invite; then the registry (match/registry.js): LOBBY_WRONG_VERSION, a seat, the
// lobby wait, or a follow ticket.
// Its lobby-wait tickets are polled at /v1/queue/:ticket (queue.js), which this registry shares with admission (M6).
// The client's protocol is its X-RJ-Wire / X-RJ-Wire-Fp headers. The join token is never logged: it is only ever in
// a response body, and request bodies and responses are not logged.

const { fail } = require('../../contract/envelope');
const { answer } = require('./queue');
const { getDB } = require('../../db');
const { route, body } = require('./util');
const inviteStorage = require('../../storage/invites');
const { INVITES_OFF } = require('./invites');

const MODES = ['quickplay', 'create_private', 'join_private', 'join_user'];

async function findUserInDb(uid) {
  const [rows] = await getDB().execute('SELECT user_id, username FROM users WHERE user_id = ? LIMIT 1', [uid]);
  return rows[0] ? { user_id: Number(rows[0].user_id), username: String(rows[0].username) } : null;
}

// match: match/registry.js's createMatchRegistry(). findUser: uid -> {user_id, username} | null (tests inject it).
// invites: {findInvite(id, {now})} (storage/invites.js; tests inject it).
function registerMatchRoutes(router, { requireSession, match, config, now = () => Date.now(), findUser = findUserInDb, invites = inviteStorage }) {
  router.post('/match/join', requireSession, route(async (req, res) => {
    const b = body(req);
    if (!MODES.includes(b.mode)) fail('VALIDATION', { message: 'Choose quickplay, create_private, join_private or join_user.' });
    if (b.mode === 'join_private' && typeof b.code !== 'string') fail('VALIDATION', { message: 'Enter a lobby code.' });
    if (b.mode === 'join_user') {
      if (config().flags.invites !== true) fail('VALIDATION', { message: INVITES_OFF });
      if (typeof b.invite !== 'string') fail('VALIDATION', { message: 'Send the invite to join.' });
    }
    const user = await findUser(req.session.uid);
    if (!user) fail('AUTH_INVALID');
    let inviter = null;
    if (b.mode === 'join_user') {
      const id = inviteStorage.normalizeInviteId(b.invite);
      const invite = id ? await invites.findInvite(id, { now: now() }) : null;
      if (!invite) fail('INVITE_INVALID');
      if (invite.user_id === user.user_id) fail('VALIDATION', { message: "That's your own invite." });
      inviter = { uid: invite.user_id, uname: invite.username };
    }
    const c = req.rjClient;
    answer(res, await match.join({
      mode: b.mode, code: b.code, inviter, uid: user.user_id, uname: user.username, install: c.install,
      wire: c.wire, fp: c.fp.toLowerCase(),
    }));
  }));
}

module.exports = { registerMatchRoutes, MODES };
