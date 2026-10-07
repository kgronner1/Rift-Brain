#!/usr/bin/env node
// Checks a remote config document before it is published (spec 4.5): every field, its type and clamp, and that
// its env is the one it is published as.
//
//   node ops/config/validate.mjs <file> --env <dev|alpha|prod>
//
// Exit 0 and "OK <file>" when it may be published; exit 1 and one line per problem when not; exit 2 on bad usage.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { validateDocument, ENVS } = require('../../src/config/remoteSchema.js');

function usage(msg) {
  if (msg) console.error(`validate.mjs: ${msg}`);
  console.error('usage: node ops/config/validate.mjs <file> --env <dev|alpha|prod>');
  process.exit(2);
}

const args = process.argv.slice(2);
let file = null;
let env = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env') env = args[++i];
  else if (args[i].startsWith('--env=')) env = args[i].slice(6);
  else if (args[i].startsWith('-')) usage(`unknown option ${args[i]}`);
  else if (file === null) file = args[i];
  else usage(`one file at a time (got ${file} and ${args[i]})`);
}
if (!file) usage('no file given');
if (!ENVS.includes(env)) usage(`--env must be one of ${ENVS.join(', ')}`);

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`FAIL ${file}: not readable JSON: ${err.message}`);
  process.exit(1);
}
const { ok, problems } = validateDocument(doc, { env });
if (!ok) {
  console.error(`FAIL ${file} (as ${env}): ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK ${file} (as ${env})`);
