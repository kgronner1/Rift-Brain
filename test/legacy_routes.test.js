'use strict';
// Today's routes still answer in today's shapes after the src/ restructure (RJ 462). No database:
// only the routes and the branches that never reach one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicApp } = require('../src/app');
const { createLobbyRegistry } = require('../src/match/lobbies');

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
