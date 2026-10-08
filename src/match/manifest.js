'use strict';
// One server binary per wire protocol (spec D5, M4). The deploy (Wobble Planet's deploy_server.sh) writes
//   <SERVERS_DIR>/manifest.json
//   { "servers": [ { "wire": 17, "fp": "9f2c4e1a0b7d3c55", "path": "wire-17-9f2c4e1a0b7d3c55/server.x86_64",
//                    "sha": "<git sha>", "deployed_at": "2026-10-08T18:00:00Z", "status": "active" | "retired" } ] }
// and the brain reads it again on every join and every spawn, so a deploy needs no brain restart.
//
// - `path` is relative to SERVERS_DIR (an absolute path is accepted when it lies inside SERVERS_DIR).
// - A withdrawn entry is simply removed; its binary stays on disk and running lobbies keep running.
// - An entry the brain cannot use (bad wire or fp, a path outside SERVERS_DIR, an unknown status) is skipped and
//   logged; one bad entry never hides the others.

const fs = require('fs');
const path = require('path');
const log = require('../log');

const MANIFEST_FILE = 'manifest.json';
const FP_RE = /^[0-9a-f]{16}$/;
const STATUSES = ['active', 'retired'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function insideDir(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The manifest's text -> { entries, problems }. Pure. entries: [{wire, fp, path (absolute), sha, deployed_at, status}].
function parseManifest(text, serversDir) {
  const problems = [];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { entries: [], problems: [`not JSON: ${e.message}`] };
  }
  if (!isObject(doc) || !Array.isArray(doc.servers)) return { entries: [], problems: ['no "servers" array'] };
  const entries = [];
  doc.servers.forEach((s, i) => {
    const at = `servers[${i}]`;
    if (!isObject(s)) return problems.push(`${at} is not an object`);
    if (!Number.isInteger(s.wire) || s.wire < 1) return problems.push(`${at}.wire must be a positive integer`);
    if (typeof s.fp !== 'string' || !FP_RE.test(s.fp)) return problems.push(`${at}.fp must be 16 lower-case hex characters`);
    if (!STATUSES.includes(s.status)) return problems.push(`${at}.status must be active or retired`);
    if (typeof s.path !== 'string' || s.path.trim() === '') return problems.push(`${at}.path is required`);
    const abs = path.resolve(serversDir, s.path);
    if (!insideDir(serversDir, abs)) return problems.push(`${at}.path must lie inside ${serversDir}`);
    if (entries.some((e) => e.wire === s.wire && e.fp === s.fp)) return problems.push(`${at} repeats wire ${s.wire} fp ${s.fp}; the first is used`);
    entries.push({
      wire: s.wire,
      fp: s.fp,
      path: abs,
      sha: typeof s.sha === 'string' ? s.sha : '',
      deployed_at: typeof s.deployed_at === 'string' ? s.deployed_at : '',
      status: s.status,
    });
    return undefined;
  });
  return { entries, problems };
}

// Which servers a client on (wire, fp) may play on (spec M4). Pure. In order:
//   wire missing or < gates.min_wire, or any entry (wire, *) retired  -> { result: 'update_required' }
//   an active (wire, fp)                                              -> { result: 'ok', entry }
//   anything else (newer than everything, withdrawn, a sibling fp)    -> { result: 'server_behind' }
function routeProtocol(entries, { wire, fp, minWire }) {
  if (!Number.isInteger(wire) || wire < Math.max(1, Number(minWire) || 0)) return { result: 'update_required' };
  if (entries.some((e) => e.wire === wire && e.status === 'retired')) return { result: 'update_required' };
  const entry = entries.find((e) => e.wire === wire && e.fp === fp && e.status === 'active');
  return entry ? { result: 'ok', entry } : { result: 'server_behind' };
}

// Reads <serversDir>/manifest.json now. A missing or broken manifest is no servers (every join SERVER_BEHIND), and
// it is logged, once per distinct problem, so a 3 s poll does not flood the log.
function createManifestReader(serversDir, { logger = log, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const file = path.join(serversDir, MANIFEST_FILE);
  let lastProblem = '';
  function report(problem) {
    if (problem === lastProblem) return;
    lastProblem = problem;
    if (problem) logger.error(`[manifest] ${file}: ${problem}`);
  }
  return {
    file,
    read() {
      let text;
      try {
        text = readFile(file);
      } catch (e) {
        report(e.code === 'ENOENT' ? 'missing: no server is deployed' : `unreadable: ${e.message}`);
        return [];
      }
      const { entries, problems } = parseManifest(text, serversDir);
      report(problems.join('; '));
      return entries;
    },
  };
}

module.exports = { parseManifest, routeProtocol, createManifestReader, MANIFEST_FILE, FP_RE };
