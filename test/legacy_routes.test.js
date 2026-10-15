'use strict';
// Today's routes still answer in today's shapes after the src/ restructure (RJ 462). No database:
// only the routes and the branches that never reach one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createLobbyRegistry } = require('../src/match/lobbies');
const { createRemoteConfig, defaultView } = require('../src/config/remote');

// Today's storage routes, every one (src/routes/legacy/storage.js).
const STORAGE_ROUTES = [
  ['POST', '/create_user'], ['POST', '/login_user'], ['POST', '/passive_login_user'], ['POST', '/app_version_compatibility'],
  ['POST', '/post_match_player_stats_update'], ['POST', '/single_player_stats_sync'], ['POST', '/player_accolades_sync'],
  ['POST', '/user_stats_columns'], ['POST', '/leaderboard_top_list'], ['POST', '/user_single_stat'],
  ['POST', '/user_all_stats'], ['POST', '/user_all_accolades'],
  ['GET', '/player_card?user_id=1'], ['GET', '/player_cards?user_ids=1,2'], ['PUT', '/player_card'],
];

// A new environment's public app (ENV dev): /v1 and no legacy registry, as app.js main() builds it.
async function startNewEnv(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const remote = createRemoteConfig({ env: 'dev', url: null, log: { info() {}, warn() {}, error() {} } });
  remote._set(defaultView('dev'));
  const app = createPublicApp(null, { v1: { env: { ENV: 'dev', SESSION_KEY: 'cd'.repeat(32) }, remote } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, p, body) => {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(base + p, init);
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  };
}

async function startApp(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const lobbies = createLobbyRegistry({
    ports: [8080],
    serverBinary: '/bin/game',
    runCommand: async (command) => (command.startsWith('kill ') ? '' : 4242),
    readyTimeoutMs: 2000,
  });
  const app = createPublicApp(lobbies);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    lobbies.stop();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  return { lobbies, get, post };
}

test('root and server health answer as before', async (t) => {
  const { get } = await startApp(t);
  assert.deepEqual(await get('/'), { status: 200, body: 0 });
  assert.deepEqual(await get('/server_health_check'), { status: 200, body: true });
});

test('quickplay spawns, waits for ready, then matches into the same lobby and queues while it is in game', async (t) => {
  const { get, lobbies } = await startApp(t);

  const first = get('/join');
  while (!lobbies.game_instances[8080]) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await get('/game_instance_ready?game_instance=8080'), { status: 200, body: { success: true } });
  assert.deepEqual(await first, { status: 200, body: { game_port: 8080 } });

  assert.deepEqual(await get('/join'), { status: 200, body: { game_port: '8080' } });

  assert.deepEqual(await get('/game_started?game_instance=8080'), { status: 200, body: { success: true } });
  const queued = await get('/join');
  assert.equal(queued.body.game_port, 4);
  assert.match(queued.body.ticket_id, /^[0-9a-f-]{36}$/);

  assert.deepEqual(await get(`/join_queue_status?ticket_id=${queued.body.ticket_id}`),
    { status: 200, body: { status: 'queued', position: 1 } });
  assert.deepEqual(await get('/game_returned_to_pregame?game_instance=8080'), { status: 200, body: { success: true } });
  assert.deepEqual(await get(`/join_queue_status?ticket_id=${queued.body.ticket_id}`),
    { status: 200, body: { status: 'admitted', game_port: 8080 } });
  assert.deepEqual(await get('/player_joined_instance?game_instance=8080'), { status: 200, body: { success: true } });
  assert.deepEqual(await get(`/leave_queue?ticket_id=${queued.body.ticket_id}`),
    { status: 200, body: { status: 'invalid' } });

  assert.deepEqual(await get('/game_ended?game_instance=9999'),
    { status: 200, body: { success: false, message: 'unknown game_instance' } });
  assert.deepEqual(await get('/player_left_instance?game_instance=8080'), { status: 200, body: { success: true } });
  assert.equal(lobbies.game_instances[8080], undefined);
});

test('the storage routes are mounted and validate before touching the database', async (t) => {
  const { post } = await startApp(t);
  assert.deepEqual(await post('/user_all_stats', { user_id: 'x' }),
    { status: 400, body: { success: false, message: 'Invalid user_id' } });
  assert.deepEqual(await post('/user_all_accolades', { user_id: 1.5 }),
    { status: 400, body: { success: false, message: 'Invalid user_id' } });
  assert.deepEqual(await post('/single_player_stats_sync', {}),
    { status: 400, body: { success: false, message: 'Missing required field: user_id' } });
});

test('RJ 494: a new environment serves none of the storage routes (404), only the probes; the legacy brain still does', async (t) => {
  const call = await startNewEnv(t);
  for (const [method, p] of STORAGE_ROUTES) {
    const r = await call(method, p, method === 'GET' ? undefined : { user_id: 1, stats: { _last_updated: 1 } });
    assert.equal(r.status, 404, `${method} ${p}`);
    const path = p.split('?')[0];
    assert.match(r.text, new RegExp(`Cannot ${method} ${path}`), `${method} ${p}: Express's own 404, nothing of the route's`);
    assert.doesNotMatch(r.text, /success|user_id|stack|at /i, `${method} ${p}`);
  }
  assert.deepEqual([(await call('GET', '/')).status, (await call('GET', '/')).text], [200, '0']);
  assert.deepEqual([(await call('GET', '/server_health_check')).status, (await call('GET', '/server_health_check')).text], [200, 'true']);
  assert.equal((await call('GET', '/join')).status, 404, 'nor the legacy matchmaking');

  const { post } = await startApp(t);
  assert.deepEqual(await post('/user_all_stats', { user_id: 'x' }),
    { status: 400, body: { success: false, message: 'Invalid user_id' } }, 'the legacy brain serves them (the 404s mean something)');
});
