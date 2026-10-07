'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEnv, loadMysqlEnv, EnvError } = require('../src/config/env');

const MYSQL = { MYSQL_HOST: 'localhost', MYSQL_USER: 'rb', MYSQL_PASSWORD: 'pw', MYSQL_DATABASE: 'rift_brain' };
const KEY = 'ab'.repeat(32);

function problems(raw) {
  try {
    loadEnv(raw);
  } catch (e) {
    assert.ok(e instanceof EnvError, e.message);
    return e.problems;
  }
  assert.fail('expected an EnvError');
}

test('ENV unset is the legacy brain, with the values the code hardcoded before', () => {
  const env = loadEnv({ ...MYSQL });
  assert.equal(env.ENV, 'legacy');
  assert.equal(env.BIND_HOST, null);
  assert.equal(env.PUBLIC_PORT, 3000);
  assert.equal(env.INTERNAL_PORT, null);
  assert.deepEqual([...env.GAME_PORTS], [8080, 8081, 8082, 8083, 8084, 8085]);
  assert.equal(env.SERVER_BINARY, '/home/ec2-user/rift_jumper_multiplayer_server_test.x86_64');
  assert.deepEqual({ ...env.MYSQL }, { host: 'localhost', user: 'rb', password: 'pw', database: 'rift_brain' });
  assert.equal(env.SESSION_KEY, null);
});

test('a new environment spells out its ports and binds loopback by default', () => {
  assert.deepEqual(problems({ ...MYSQL, ENV: 'dev' }).sort(), [
    'GAME_PORTS is required when ENV=dev',
    'PUBLIC_PORT is required when ENV=dev',
    'SERVER_BINARY is required when ENV=dev',
  ]);
  const env = loadEnv({
    ...MYSQL, ENV: 'dev', PUBLIC_PORT: '3001', INTERNAL_PORT: '3101', GAME_PORTS: '8100-8104',
    SERVER_BINARY: '/opt/rj/dev/server.x86_64', SESSION_KEY: KEY.toUpperCase(),
    CONFIG_URL: 'https://config.example.com/dev/client.v1.json',
  });
  assert.equal(env.BIND_HOST, '127.0.0.1');
  assert.equal(env.PUBLIC_PORT, 3001);
  assert.equal(env.INTERNAL_PORT, 3101);
  assert.deepEqual([...env.GAME_PORTS], [8100, 8101, 8102, 8103, 8104]);
  assert.equal(env.SESSION_KEY, KEY);
  assert.ok(Object.isFrozen(env));
});

test('port lists take ranges and singles, in order', () => {
  const env = loadEnv({ ...MYSQL, GAME_PORTS: '8090, 8092-8093,8091' });
  assert.deepEqual([...env.GAME_PORTS], [8090, 8092, 8093, 8091]);
});

test('every bad value is reported at once', () => {
  const p = problems({
    ENV: 'staging', PUBLIC_PORT: '70000', GAME_PORTS: '8085-8080,abc', SESSION_KEY: 'short',
    CONFIG_URL: 'http://config.example.com/x.json',
  });
  const text = p.join('\n');
  for (const needle of ['ENV must be one of', 'PUBLIC_PORT must be in 1..65535', 'runs backwards',
    'GAME_PORTS must be a port number', 'SESSION_KEY must be 64 hex', 'CONFIG_URL must be https',
    'MYSQL_HOST is required', 'MYSQL_PASSWORD is required']) {
    assert.ok(text.includes(needle), `missing "${needle}" in:\n${text}`);
  }
});

test('ports may not collide', () => {
  const p = problems({ ...MYSQL, PUBLIC_PORT: '8080', INTERNAL_PORT: '8080', GAME_PORTS: '8080,8080' });
  const text = p.join('\n');
  assert.ok(text.includes('INTERNAL_PORT must differ from PUBLIC_PORT'));
  assert.ok(text.includes('GAME_PORTS names a port twice'));
  assert.ok(text.includes("GAME_PORTS must not include the brain's own port 8080"));
});

test('an empty MYSQL_PASSWORD is allowed, a missing one is not', () => {
  assert.equal(loadMysqlEnv({ ...MYSQL, MYSQL_PASSWORD: '' }).password, '');
  const { MYSQL_PASSWORD, ...noPassword } = MYSQL;
  assert.throws(() => loadMysqlEnv(noPassword), /MYSQL_PASSWORD is required/);
  assert.equal(loadMysqlEnv({ ...MYSQL, MYSQL_PORT: '3307' }).port, 3307);
});
