#!/usr/bin/env node
// The JSON work the drill scripts need, so none of them parses JSON in bash. Pure: reads files or stdin, writes stdout.
//
//   drill.mjs get <file> <path>              the value at a dotted path (a string bare, anything else as JSON; "" if absent)
//   drill.mjs set <file> <path> <json>       the document with that value set, on stdout
//   drill.mjs envelope <status> < body       one line: "<status> <result> <code> <scope> <retry kind> <after_ms> <action>"
//                                            (a field that is absent is "-"; a body that is not JSON is result "unparsed")
//   drill.mjs session < body                 "<user id> <session token>" from a /v1/session ok, else nothing (exit 1)
//   drill.mjs credential < body              the credential of a /v1/session login, as {"user_id","token"} JSON (exit 1 if none)
import { readFileSync } from 'node:fs';

function die(msg) {
  console.error(`drill.mjs: ${msg}`);
  process.exit(2);
}

function load(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return die(`${file}: ${err.message}`);
  }
}

function stdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function at(obj, path) {
  let v = obj;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || !(k in v)) return undefined;
    v = v[k];
  }
  return v;
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'get': {
    const v = at(load(rest[0]), rest[1]);
    if (v === undefined) console.log('');
    else console.log(typeof v === 'string' ? v : JSON.stringify(v));
    break;
  }
  case 'set': {
    const doc = load(rest[0]);
    let value;
    try {
      value = JSON.parse(rest[2]);
    } catch {
      die(`not JSON: ${rest[2]}`);
    }
    const keys = rest[1].split('.');
    let o = doc;
    for (const k of keys.slice(0, -1)) {
      if (o[k] === null || typeof o[k] !== 'object') o[k] = {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = value;
    console.log(JSON.stringify(doc, null, 2));
    break;
  }
  case 'envelope': {
    const status = rest[0] || '-';
    let b;
    try {
      b = JSON.parse(stdin());
    } catch {
      console.log(`${status} unparsed - - - - -`);
      break;
    }
    const e = (b && b.error) || {};
    const f = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
    console.log([status, f(b && b.result), f(e.code), f(e.scope), f(e.retry && e.retry.kind),
      f(e.retry && e.retry.after_ms), f(e.action && e.action.kind)].join(' '));
    break;
  }
  case 'session': {
    let b;
    try {
      b = JSON.parse(stdin());
    } catch {
      process.exit(1);
    }
    const uid = at(b, 'data.user.id');
    const token = at(b, 'data.session.token');
    if (!Number.isInteger(uid) || typeof token !== 'string') process.exit(1);
    console.log(`${uid} ${token}`);
    break;
  }
  case 'credential': {
    let b;
    try {
      b = JSON.parse(stdin());
    } catch {
      process.exit(1);
    }
    const c = at(b, 'data.credential');
    const uid = at(b, 'data.user.id');
    const token = c && typeof c === 'object' ? c.token : c;
    if (!Number.isInteger(uid) || typeof token !== 'string') process.exit(1);
    console.log(JSON.stringify({ user_id: uid, token }));
    break;
  }
  default:
    die('usage: drill.mjs get|set|envelope|session|credential ...');
}
