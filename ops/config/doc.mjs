#!/usr/bin/env node
// The JSON work publish.sh and rollback.sh need, so neither parses JSON in bash. Pure: reads files, writes stdout.
//
//   doc.mjs serial <file>                         the document's serial (0 when the file is absent or empty)
//   doc.mjs stamp <file> --serial N [--now ISO]   the document with that serial and published_at, as published
//   doc.mjs locks <live|-> <next>                 one line per build the change newly locks out; exit 3 when any
//   doc.mjs diff <a|-> <b>                        changed fields, "path: old -> new" ("-" is an empty document)
//   doc.mjs same <a> <b>                          exit 0 when both parse to the same document, 1 when not
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { newLocks, stamp, diffDocuments } = require('../../src/config/remoteSchema.js');

function die(msg, code = 2) {
  console.error(`doc.mjs: ${msg}`);
  process.exit(code);
}

function load(file, { optional = false } = {}) {
  if (file === '-' || (optional && (!existsSync(file) || readFileSync(file, 'utf8').trim() === ''))) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return die(`${file}: ${err.message}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'serial': {
    const doc = load(rest[0], { optional: true });
    const s = doc && Number.isInteger(doc.serial) ? doc.serial : 0;
    console.log(String(s));
    break;
  }
  case 'stamp': {
    const doc = load(rest[0]);
    let serial = null;
    let now = new Date();
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--serial') serial = Number(rest[++i]);
      else if (rest[i] === '--now') now = new Date(rest[++i]);
      else die(`stamp: unknown option ${rest[i]}`);
    }
    if (!Number.isInteger(serial) || serial < 1) die('stamp: --serial must be a positive integer');
    if (Number.isNaN(now.getTime())) die('stamp: --now is not a time');
    process.stdout.write(`${JSON.stringify(stamp(doc, { serial, now }), null, 2)}\n`);
    break;
  }
  case 'locks': {
    const locks = newLocks(load(rest[0], { optional: true }), load(rest[1]));
    for (const l of locks) console.log(l.text);
    process.exit(locks.length ? 3 : 0);
    break;
  }
  case 'diff': {
    const lines = diffDocuments(load(rest[0], { optional: true }), load(rest[1]));
    console.log(lines.length ? lines.join('\n') : '(no field changed)');
    break;
  }
  case 'same': {
    process.exit(JSON.stringify(load(rest[0])) === JSON.stringify(load(rest[1])) ? 0 : 1);
    break;
  }
  default:
    die('usage: doc.mjs serial|stamp|locks|diff|same ...');
}
