'use strict';
// Matchmaking (spec 4.10, M4):
//   POST   /v1/match/join     🔒🎮 {mode: quickplay|create_private|join_private, code?}
//            ok {host, port, join_token, private_code?} | queued (kind lobby) | LOBBY_NOT_FOUND | LOBBY_FULL |
//            LOBBY_WRONG_VERSION | NO_CAPACITY | UPDATE_REQUIRED | SERVER_BEHIND | MAINTENANCE (clientHeaders)
// Its lobby-wait tickets are polled at /v1/queue/:ticket (queue.js), which this registry shares with admission (M6).
// The client's protocol is its X-RJ-Wire / X-RJ-Wire-Fp headers. The join token is never logged: it is only ever in
// a response body, and request bodies and responses are not logged.

const { fail } = require('../../contract/envelope');
const { answer } = require('./queue');
const { getDB } = require('../../db');
const { route, body } = require('./util');

const MODES = ['quickplay', 'create_private', 'join_private'];

async function findUserInDb(uid) {
  const [rows] = await getDB().execute('SELECT user_id, username FROM users WHERE user_id = ? LIMIT 1', [uid]);
  return rows[0] ? { user_id: Number(rows[0].user_id), username: String(rows[0].username) } : null;
}

// match: match/registry.js's createMatchRegistry(). findUser: uid -> {user_id, username} | null (tests inject it).
function registerMatchRoutes(router, { requireSession, match, findUser = findUserInDb }) {
  router.post('/match/join', requireSession, route(async (req, res) => {
    const b = body(req);
    if (!MODES.includes(b.mode)) fail('VALIDATION', { message: 'Choose quickplay, create_private or join_private.' });
    if (b.mode === 'join_private' && typeof b.code !== 'string') fail('VALIDATION', { message: 'Enter a lobby code.' });
    const user = await findUser(req.session.uid);
    if (!user) fail('AUTH_INVALID');
    const c = req.rjClient;
    answer(res, await match.join({
      mode: b.mode, code: b.code, uid: user.user_id, uname: user.username, install: c.install,
      wire: c.wire, fp: c.fp.toLowerCase(),
    }));
  }));
}

module.exports = { registerMatchRoutes, MODES };
