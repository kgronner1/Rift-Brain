'use strict';
// RJ 510: the public app's access log (morgan `tiny`) leaves out a Route 53 health check the brain passed, and
// nothing else. No database: a new environment's probes (app.js createPublicApp).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPublicApp } = require('../src/app');

// What Route 53 sent alpha's brain on 2026-10-20 (tcpdump on the box's loopback).
const ROUTE53 =
  'Amazon-Route53-Health-Check-Service (ref 2b5e2e0b-6d3a-4a6e-9a39-0c1f5b0f2d11; report http://amzn.to/1vsZADi)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

async function start(t) {
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const server = await new Promise((resolve) => {
    const s = createPublicApp(null).listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, ua, signal) => {
    const r = await fetch(base + p, { method, headers: { 'User-Agent': ua }, signal });
    return { status: r.status, text: await r.text() };
  };
  // morgan writes when the response finishes, which can land just after the client has it.
  const waitFor = async (re, count = 1) => {
    for (let i = 0; i < 200 && lines.filter((l) => re.test(l)).length < count; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return lines.filter((l) => re.test(l));
  };
  return { lines, call, waitFor };
}

test('a health check the brain passed writes no log line; the same request from anyone else does', async (t) => {
  const { lines, call, waitFor } = await start(t);
  assert.deepEqual(await call('GET', '/', ROUTE53), { status: 200, text: '0' });
  assert.deepEqual(await call('GET', '/', ROUTE53), { status: 200, text: '0' });
  // The control: a browser's GET / is logged, so the log is being read, and it comes after both checks finished.
  assert.deepEqual(await call('GET', '/', BROWSER), { status: 200, text: '0' });
  assert.equal((await waitFor(/^GET \/ 200 /)).length, 1, lines.join('\n'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lines.filter((l) => /^GET \/ /.test(l)).length, 1, lines.join('\n'));
});

test('a health check answered with an error is logged', async (t) => {
  const { lines, call, waitFor } = await start(t);
  t.mock.method(express.response, 'status', function () {
    this.statusCode = 503;
    return this;
  });
  assert.equal((await call('GET', '/', ROUTE53)).status, 503);
  assert.equal((await waitFor(/^GET \/ 503 /)).length, 1, lines.join('\n'));
});

test('a health check never answered is logged', async (t) => {
  const { lines, call, waitFor } = await start(t);
  t.mock.method(express.response, 'send', function () {
    return this;
  });
  await assert.rejects(call('GET', '/', ROUTE53, AbortSignal.timeout(100)));
  assert.equal((await waitFor(/^GET \/ - /)).length, 1, lines.join('\n'));
});

test('with Route 53\'s User-Agent, every other request is still logged', async (t) => {
  const { lines, call, waitFor } = await start(t);
  const cases = [
    ['GET', '/?url=http%3A%2F%2F169.254.169.254%2F', 200, /^GET \/\?url=http%3A%2F%2F169\.254\.169\.254%2F 200 /],
    ['HEAD', '/', 200, /^HEAD \/ 200 /],
    ['POST', '/', 404, /^POST \/ 404 /],
    ['GET', '/server_health_check', 200, /^GET \/server_health_check 200 /],
    ['GET', '/favicon.ico', 404, /^GET \/favicon\.ico 404 /],
  ];
  for (const [method, p, status, re] of cases) {
    assert.equal((await call(method, p, ROUTE53)).status, status, `${method} ${p}`);
    assert.equal((await waitFor(re)).length, 1, `${method} ${p}:\n${lines.join('\n')}`);
  }
  assert.equal((await call('GET', '/', `${BROWSER} ${ROUTE53}`)).status, 200);
  assert.equal((await waitFor(/^GET \/ 200 /)).length, 1, `a User-Agent that only contains it:\n${lines.join('\n')}`);
});
