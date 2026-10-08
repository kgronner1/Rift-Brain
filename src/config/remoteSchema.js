'use strict';
// The remote config document, schema 1 (spec 4.5): https://config.<domain>/<env>/client.v1.json.
// Pure. ops/config/validate.mjs checks a document before it is published; src/config/remote.js (M3) will read the
// published one with the same rules.
//
// A published document is checked STRICTLY: every field present, of its type and inside its clamp, and no field
// this file does not know (a typo such as "ttl_secs" would otherwise publish silently and be ignored by every
// client). The clamps are the client's own (Scripts/Net/RemoteConfigSchema.gd, M2); a value the client would reject
// can never be published.

const DOMAIN = 'riftjumpers.space';
const ENVS = ['dev', 'alpha', 'prod'];
const SCHEMA = 1;
const PLATFORMS = ['default', 'android', 'ios'];
const FIRST_WIRE = 1;
const MAINTENANCE_SCOPES = ['multiplayer', 'app'];
const NOTICE_LEVELS = ['info', 'warning', 'critical'];
const ACTION_KINDS = ['dismiss', 'retry', 'open_url', 'open_store', 'login'];
const FLAG_NAMES = ['multiplayer', 'quickplay', 'private_lobbies', 'account_creation'];
const MESSAGE_MAX = 280;
const DOCUMENT_MAX_BYTES = 64 * 1024;
// A config document is public. Every key is a known field already (no "session_key" can get in), so what is left
// to catch is a secret pasted into a string: a hex or base64 key, a PEM block, an AWS access key id.
// A URL's path can run long without being a key, so the base64 run is not looked for in one.
const SECRET_VALUE_RES = [/[0-9a-f]{32,}/i, /-----BEGIN [A-Z ]+-----/, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/];
const SECRET_RUN_RE = /[A-Za-z0-9+/_-]{40,}={0,2}/;

const CLAMPS = Object.freeze({
  ttl_sec: [60, 86400],
  'tunables.http_timeout_ms': [2000, 30000],
  'tunables.config_fetch_timeout_ms': [1000, 10000],
  'tunables.backoff.base_ms': [250, 30000],
  'tunables.backoff.cap_ms': [5000, 1800000],
  'tunables.session_restore_max_attempts': [1, 20],
  'tunables.queue_poll_default_ms': [1000, 120000],
  'tunables.join_connect_timeout_ms': [1000, 15000],
  'tunables.handshake_timeout_ms': [1000, 15000],
});

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 40)}...` : v}"`;
  return `${typeof v} ${JSON.stringify(v)}`;
}

function isIsoUtc(s) {
  return typeof s === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s)
    && !Number.isNaN(Date.parse(s));
}

// https://<anything>.<domain>, nothing else: a bad publish must never point clients at a foreign host.
function isOwnHttpsUrl(s, domain) {
  if (typeof s !== 'string') return false;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return false;
  }
  return u.protocol === 'https:' && u.hostname.endsWith(`.${domain}`) && u.username === '' && u.password === '';
}

function isHttpsUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Collects problems with their dotted path. Each check returns whether the value passed.
function makeChecker() {
  const problems = [];
  const fail = (path, why) => {
    problems.push(`${path}: ${why}`);
    return false;
  };
  const c = {
    problems,
    fail,
    object(path, v) {
      return isObject(v) || fail(path, `must be an object, got ${describe(v)}`);
    },
    keys(path, obj, allowed) {
      let ok = true;
      for (const k of Object.keys(obj)) {
        if (!allowed.includes(k)) ok = fail(path ? `${path}.${k}` : k, 'is not a schema 1 field (a typo?)');
      }
      for (const k of allowed) {
        if (!(k in obj)) ok = fail(path ? `${path}.${k}` : k, 'is missing');
      }
      return ok;
    },
    bool(path, v) {
      return typeof v === 'boolean' || fail(path, `must be true or false, got ${describe(v)}`);
    },
    string(path, v, max) {
      if (typeof v !== 'string') return fail(path, `must be a string, got ${describe(v)}`);
      if (max !== undefined && v.length > max) return fail(path, `must be at most ${max} characters, got ${v.length}`);
      return true;
    },
    int(path, v, lo, hi) {
      if (!Number.isInteger(v)) return fail(path, `must be an integer, got ${describe(v)}`);
      if (lo !== undefined && v < lo) return fail(path, `must be at least ${lo}, got ${v}`);
      if (hi !== undefined && v > hi) return fail(path, `must be at most ${hi}, got ${v}`);
      return true;
    },
    clamped(path, v) {
      const [lo, hi] = CLAMPS[path];
      return c.int(path, v, lo, hi);
    },
    oneOf(path, v, values) {
      return values.includes(v) || fail(path, `must be one of ${values.join(', ')}, got ${describe(v)}`);
    },
    httpsOrEmpty(path, v) {
      if (!c.string(path, v)) return false;
      return v === '' || isHttpsUrl(v) || fail(path, `must be an https:// URL or "", got ${describe(v)}`);
    },
  };
  return c;
}

function checkPlatformGate(c, path, v) {
  if (!c.object(path, v)) return;
  for (const k of Object.keys(v)) {
    if (!PLATFORMS.includes(k)) c.fail(`${path}.${k}`, `is not a platform (${PLATFORMS.join(', ')})`);
    else c.int(`${path}.${k}`, v[k], 0);
  }
  if (!('default' in v)) c.fail(`${path}.default`, 'is missing');
}

function checkSecrets(c, path, v) {
  if (typeof v === 'string') {
    const run = !/^https:\/\//.test(v) && SECRET_RUN_RE.test(v);
    if (run || SECRET_VALUE_RES.some((re) => re.test(v))) c.fail(path, 'looks like it holds a key or secret, and this document is public');
    return;
  }
  if (!isObject(v)) return;
  for (const [k, child] of Object.entries(v)) checkSecrets(c, path ? `${path}.${k}` : k, child);
}

// validateDocument(doc, { env }) -> { ok, problems: [string] }.
// env: the environment the document is published as; the document's own env must equal it.
function validateDocument(doc, { env, domain = DOMAIN } = {}) {
  const c = makeChecker();
  if (env !== undefined && !ENVS.includes(env)) c.fail('(env)', `the target environment must be one of ${ENVS.join(', ')}, got ${describe(env)}`);
  if (!c.object('(document)', doc)) return { ok: false, problems: c.problems };

  c.keys('', doc, ['schema', 'env', 'serial', 'published_at', 'ttl_sec', 'endpoints', 'gates', 'notice', 'tunables',
    'flags', 'links', 'messages', 'server']);

  if ('schema' in doc && doc.schema !== SCHEMA) c.fail('schema', `must be ${SCHEMA} in client.v1.json, got ${describe(doc.schema)}`);
  if ('env' in doc && c.oneOf('env', doc.env, ENVS) && env !== undefined && doc.env !== env) {
    c.fail('env', `is "${doc.env}" but the document is published as ${env}: a copy-paste across environments?`);
  }
  if ('serial' in doc) c.int('serial', doc.serial, 0);
  if ('published_at' in doc && !isIsoUtc(doc.published_at)) {
    c.fail('published_at', `must be an ISO 8601 UTC time (2026-10-02T18:00:00Z), got ${describe(doc.published_at)}`);
  }
  if ('ttl_sec' in doc) c.clamped('ttl_sec', doc.ttl_sec);

  if ('endpoints' in doc && c.object('endpoints', doc.endpoints)) {
    const e = doc.endpoints;
    c.keys('endpoints', e, ['api']);
    if ('api' in e && !isOwnHttpsUrl(e.api, domain)) {
      c.fail('endpoints.api', `must be https:// on a host ending in .${domain}, got ${describe(e.api)}`);
    } else if ('api' in e && new URL(e.api).pathname !== '/') {
      c.fail('endpoints.api', `must be a bare origin (no path), got ${describe(e.api)}`);
    }
  }

  if ('gates' in doc && c.object('gates', doc.gates)) {
    const g = doc.gates;
    c.keys('gates', g, ['min_build', 'min_build_multiplayer', 'min_wire', 'maintenance']);
    if ('min_build' in g) checkPlatformGate(c, 'gates.min_build', g.min_build);
    if ('min_build_multiplayer' in g) checkPlatformGate(c, 'gates.min_build_multiplayer', g.min_build_multiplayer);
    if ('min_wire' in g) c.int('gates.min_wire', g.min_wire, 0);
    if ('maintenance' in g && c.object('gates.maintenance', g.maintenance)) {
      const m = g.maintenance;
      c.keys('gates.maintenance', m, ['active', 'scope', 'title', 'message', 'ends_at']);
      if ('active' in m) c.bool('gates.maintenance.active', m.active);
      if ('scope' in m) c.oneOf('gates.maintenance.scope', m.scope, MAINTENANCE_SCOPES);
      if ('title' in m) c.string('gates.maintenance.title', m.title, MESSAGE_MAX);
      if ('message' in m && c.string('gates.maintenance.message', m.message, MESSAGE_MAX)
        && m.active === true && m.message.trim() === '') {
        c.fail('gates.maintenance.message', 'is empty while maintenance is active: players would see a blank lock');
      }
      if ('ends_at' in m && m.ends_at !== null && !isIsoUtc(m.ends_at)) {
        c.fail('gates.maintenance.ends_at', `must be null or an ISO 8601 UTC time, got ${describe(m.ends_at)}`);
      }
    }
  }

  if ('notice' in doc && c.object('notice', doc.notice)) {
    const n = doc.notice;
    c.keys('notice', n, ['id', 'level', 'message', 'url', 'dismissible']);
    if ('id' in n) c.string('notice.id', n.id, 64);
    if ('level' in n) c.oneOf('notice.level', n.level, NOTICE_LEVELS);
    if ('message' in n && c.string('notice.message', n.message, MESSAGE_MAX)
      && typeof n.id === 'string' && n.id !== '' && n.message.trim() === '') {
      c.fail('notice.message', `is empty but notice.id is "${n.id}": players would see a blank notice`);
    }
    if ('url' in n) c.httpsOrEmpty('notice.url', n.url);
    if ('dismissible' in n) c.bool('notice.dismissible', n.dismissible);
  }

  if ('tunables' in doc && c.object('tunables', doc.tunables)) {
    const t = doc.tunables;
    c.keys('tunables', t, ['http_timeout_ms', 'config_fetch_timeout_ms', 'backoff', 'session_restore_max_attempts',
      'queue_poll_default_ms', 'join_connect_timeout_ms', 'handshake_timeout_ms']);
    for (const k of ['http_timeout_ms', 'config_fetch_timeout_ms', 'session_restore_max_attempts',
      'queue_poll_default_ms', 'join_connect_timeout_ms', 'handshake_timeout_ms']) {
      if (k in t) c.clamped(`tunables.${k}`, t[k]);
    }
    if ('backoff' in t && c.object('tunables.backoff', t.backoff)) {
      const b = t.backoff;
      c.keys('tunables.backoff', b, ['base_ms', 'cap_ms']);
      const baseOk = 'base_ms' in b && c.clamped('tunables.backoff.base_ms', b.base_ms);
      const capOk = 'cap_ms' in b && c.clamped('tunables.backoff.cap_ms', b.cap_ms);
      if (baseOk && capOk && b.cap_ms < b.base_ms) {
        c.fail('tunables.backoff.cap_ms', `must be at least base_ms (${b.base_ms}), got ${b.cap_ms}`);
      }
    }
  }

  if ('flags' in doc && c.object('flags', doc.flags)) {
    c.keys('flags', doc.flags, FLAG_NAMES);
    for (const k of FLAG_NAMES) if (k in doc.flags) c.bool(`flags.${k}`, doc.flags[k]);
  }

  if ('links' in doc && c.object('links', doc.links)) {
    const l = doc.links;
    c.keys('links', l, ['store', 'support']);
    if ('store' in l && c.object('links.store', l.store)) {
      c.keys('links.store', l.store, ['android', 'ios']);
      for (const k of ['android', 'ios']) if (k in l.store) c.httpsOrEmpty(`links.store.${k}`, l.store[k]);
    }
    if ('support' in l) c.httpsOrEmpty('links.support', l.support);
  }

  if ('messages' in doc && c.object('messages', doc.messages)) {
    for (const [code, m] of Object.entries(doc.messages)) {
      const p = `messages.${code}`;
      if (!/^[A-Z][A-Z0-9_]*$/.test(code)) c.fail(p, 'is not an error code (UPPER_SNAKE_CASE)');
      if (!c.object(p, m)) continue;
      for (const k of Object.keys(m)) {
        if (!['title', 'message', 'action'].includes(k)) c.fail(`${p}.${k}`, 'is not a message field (title, message, action)');
      }
      if (!('message' in m)) c.fail(`${p}.message`, 'is missing');
      else if (c.string(`${p}.message`, m.message, MESSAGE_MAX) && m.message.trim() === '') c.fail(`${p}.message`, 'is empty');
      if ('title' in m) c.string(`${p}.title`, m.title, MESSAGE_MAX);
      if ('action' in m && c.object(`${p}.action`, m.action)) {
        const a = m.action;
        for (const k of Object.keys(a)) {
          if (!['kind', 'label', 'url'].includes(k)) c.fail(`${p}.action.${k}`, 'is not an action field (kind, label, url)');
        }
        if (!('kind' in a)) c.fail(`${p}.action.kind`, 'is missing');
        else c.oneOf(`${p}.action.kind`, a.kind, ACTION_KINDS);
        if ('label' in a) c.string(`${p}.action.label`, a.label, 40);
        if ('url' in a && !isHttpsUrl(a.url)) c.fail(`${p}.action.url`, `must be an https:// URL, got ${describe(a.url)}`);
        if (a.kind === 'open_url' && !('url' in a)) c.fail(`${p}.action.url`, 'is required by open_url');
      }
    }
  }

  if ('server' in doc && c.object('server', doc.server)) {
    const s = doc.server;
    c.keys('server', s, ['admission', 'lobby_queue_max', 'rate_limits']);
    if ('admission' in s && c.object('server.admission', s.admission)) {
      const a = s.admission;
      c.keys('server.admission', a, ['enabled', 'rate_per_min', 'burst', 'grant_ttl_sec', 'ticket_ttl_sec',
        'session_refresh_grace_sec']);
      if ('enabled' in a) c.bool('server.admission.enabled', a.enabled);
      if ('rate_per_min' in a) c.int('server.admission.rate_per_min', a.rate_per_min, 1, 100000);
      if ('burst' in a) c.int('server.admission.burst', a.burst, 1, 100000);
      if ('grant_ttl_sec' in a) c.int('server.admission.grant_ttl_sec', a.grant_ttl_sec, 10, 3600);
      if ('ticket_ttl_sec' in a) c.int('server.admission.ticket_ttl_sec', a.ticket_ttl_sec, 30, 86400);
      if ('session_refresh_grace_sec' in a) c.int('server.admission.session_refresh_grace_sec', a.session_refresh_grace_sec, 0, 604800);
    }
    if ('lobby_queue_max' in s) c.int('server.lobby_queue_max', s.lobby_queue_max, 0, 100000);
    if ('rate_limits' in s && c.object('server.rate_limits', s.rate_limits)) {
      const r = s.rate_limits;
      c.keys('server.rate_limits', r, ['login_per_min_ip', 'login_per_min_account', 'restore_per_min_credential']);
      for (const k of ['login_per_min_ip', 'login_per_min_account', 'restore_per_min_credential']) {
        if (k in r) c.int(`server.rate_limits.${k}`, r[k], 1, 100000);
      }
    }
  }

  checkSecrets(c, '', doc);

  const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  if (bytes > DOCUMENT_MAX_BYTES) c.fail('(document)', `is ${bytes} bytes; keep it under ${DOCUMENT_MAX_BYTES}`);

  return { ok: c.problems.length === 0, problems: c.problems };
}

// The floor a platform sees: its own key, then default (spec 4.5).
function floorFor(gate, platform) {
  if (!isObject(gate)) return 0;
  if (Number.isInteger(gate[platform])) return gate[platform];
  return Number.isInteger(gate.default) ? gate.default : 0;
}

function maintenanceLocksApp(doc) {
  const m = doc && doc.gates && doc.gates.maintenance;
  return isObject(m) && m.active === true && m.scope === 'app';
}

// What publishing `next` over `live` (null: nothing published yet) locks out that was not locked before.
// Returns [{ field, platform?, from, to, text }]; empty means the publish locks nobody new.
// A floor that falls, or maintenance that ends, is not a lock and needs no confirmation.
function newLocks(live, next) {
  const locks = [];
  const liveGates = (live && live.gates) || {};
  const nextGates = (next && next.gates) || {};
  const platforms = ['android', 'ios', 'default'];
  for (const [field, what] of [['min_build', 'can no longer open the app'],
    ['min_build_multiplayer', 'can no longer play online']]) {
    for (const platform of platforms) {
      const from = floorFor(liveGates[field], platform);
      const to = floorFor(nextGates[field], platform);
      if (to > from) {
        const who = platform === 'default' ? 'builds on any other platform' : `${platform} builds`;
        locks.push({ field: `gates.${field}`, platform, from, to,
          text: `gates.${field} ${platform}: ${from} -> ${to}: ${who} ${from}..${to - 1} ${what}` });
      }
    }
  }
  // Wire 1 is the first protocol any build speaks, so a floor of 1 (or none yet) locks nobody.
  const wireFrom = Number.isInteger(liveGates.min_wire) ? Math.max(liveGates.min_wire, FIRST_WIRE) : FIRST_WIRE;
  const wireTo = Number.isInteger(nextGates.min_wire) ? nextGates.min_wire : FIRST_WIRE;
  if (wireTo > wireFrom) {
    locks.push({ field: 'gates.min_wire', from: wireFrom, to: wireTo,
      text: `gates.min_wire: ${wireFrom} -> ${wireTo}: every build on wire ${wireFrom}..${wireTo - 1} can no longer play online` });
  }
  if (maintenanceLocksApp(next) && !maintenanceLocksApp(live)) {
    locks.push({ field: 'gates.maintenance', from: 'unlocked', to: 'app',
      text: 'gates.maintenance: active with scope "app": every build, on every platform, is locked out of the whole app' });
  }
  return locks;
}

// The document as it is published: the next serial and the time, everything else as written.
function stamp(doc, { serial, now = new Date() }) {
  const out = { ...doc, serial, published_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  return out;
}

// Changed leaf paths between two documents, as "path: old -> new" lines, sorted. serial and published_at are
// left out unless includeStamp: every publish changes them.
function diffDocuments(a, b, { includeStamp = false } = {}) {
  const lines = [];
  const walk = (path, x, y) => {
    if (isObject(x) && isObject(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        if (!path && !includeStamp && (k === 'serial' || k === 'published_at')) continue;
        walk(path ? `${path}.${k}` : k, x[k], y[k]);
      }
      return;
    }
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v));
    lines.push(`${path}: ${show(x)} -> ${show(y)}`);
  };
  walk('', isObject(a) ? a : {}, isObject(b) ? b : {});
  return lines;
}

module.exports = {
  DOMAIN,
  ENVS,
  SCHEMA,
  CLAMPS,
  validateDocument,
  newLocks,
  floorFor,
  stamp,
  diffDocuments,
};
