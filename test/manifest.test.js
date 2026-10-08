'use strict';
// The per-protocol manifest (spec M4): its format, and routing a client on (wire, fp).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManifest, routeProtocol, createManifestReader } = require('../src/match/manifest');

const DIR = '/opt/rj/dev/servers';
const FP_A = '9f2c4e1a0b7d3c55';
const FP_B = '0123456789abcdef';

function entry(wire, fp, status = 'active') {
  return { wire, fp, path: `wire-${wire}-${fp}/server.x86_64`, sha: 'abc123', deployed_at: '2026-10-08T18:00:00Z', status };
}

test('a manifest entry resolves its path inside SERVERS_DIR', () => {
  const { entries, problems } = parseManifest(JSON.stringify({ servers: [entry(17, FP_A)] }), DIR);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries, [{
    wire: 17, fp: FP_A, path: `${DIR}/wire-17-${FP_A}/server.x86_64`, sha: 'abc123',
    deployed_at: '2026-10-08T18:00:00Z', status: 'active',
  }]);
  const abs = parseManifest(JSON.stringify({ servers: [{ ...entry(17, FP_A), path: `${DIR}/wire-17-${FP_A}/server.x86_64` }] }), DIR);
  assert.equal(abs.entries[0].path, `${DIR}/wire-17-${FP_A}/server.x86_64`);
});

test('a bad entry is skipped and reported; the others still route', () => {
  const doc = {
    servers: [
      entry(17, FP_A),
      { ...entry(18, FP_A), path: '../../../bin/sh' },
      { ...entry(19, FP_A), path: '/bin/sh' },
      { ...entry(20, FP_A), fp: 'NOT-HEX' },
      { ...entry(21, FP_A), status: 'withdrawn' },
      { ...entry(0, FP_A) },
      entry(17, FP_A),
      'junk',
    ],
  };
  const { entries, problems } = parseManifest(JSON.stringify(doc), DIR);
  assert.deepEqual(entries.map((e) => e.wire), [17]);
  assert.equal(problems.length, 7, problems.join('\n'));
  assert.deepEqual(parseManifest('{', DIR).entries, []);
  assert.deepEqual(parseManifest('{"servers": {}}', DIR).problems, ['no "servers" array']);
});

test('routing on (wire, fp): the floor, retired, exact match, and everything else is SERVER_BEHIND', () => {
  const entries = parseManifest(JSON.stringify({
    servers: [entry(15, FP_A, 'retired'), entry(16, FP_A), entry(17, FP_A), entry(17, FP_B)],
  }), DIR).entries;
  const at = (wire, fp, minWire = 1) => routeProtocol(entries, { wire, fp, minWire }).result;
  assert.equal(at(17, FP_A), 'ok');
  assert.equal(routeProtocol(entries, { wire: 17, fp: FP_B, minWire: 1 }).entry.fp, FP_B);
  assert.equal(at(16, FP_A, 17), 'update_required', 'below gates.min_wire');
  assert.equal(at(15, FP_A), 'update_required', 'a retired wire');
  assert.equal(at(15, FP_B), 'update_required', 'any fingerprint of a retired wire');
  assert.equal(at(null, FP_A), 'update_required', 'no X-RJ-Wire at all');
  assert.equal(at(18, FP_A), 'server_behind', 'newer than everything deployed');
  assert.equal(at(16, FP_B), 'server_behind', 'a sibling build on the same wire');
  assert.equal(routeProtocol([], { wire: 17, fp: FP_A, minWire: 1 }).result, 'server_behind', 'withdrawn / nothing deployed');
});

test('the reader re-reads the file on every call; a missing file is no servers, logged once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-manifest-'));
  const lines = [];
  const reader = createManifestReader(dir, { logger: { error: (l) => lines.push(l) } });
  assert.deepEqual(reader.read(), []);
  assert.deepEqual(reader.read(), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /missing/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ servers: [entry(17, FP_A)] }));
  assert.equal(reader.read()[0].path, path.join(dir, `wire-17-${FP_A}/server.x86_64`));
  fs.rmSync(dir, { recursive: true, force: true });
});
