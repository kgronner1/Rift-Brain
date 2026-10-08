'use strict';
// The brain's copy of its environment's remote config document (spec 4.5, 5): fetched from CONFIG_URL at boot and
// every 30 s. The gates the client sees are the gates the brain enforces.
//
// It reads the published document as a tolerant reader (spec 4.1): field by field, a field of the wrong type or out
// of range keeps the value it had, and unknown fields are ignored, so a document a newer publish script wrote never
// takes the brain down. remoteSchema.js is the strict check a document passes BEFORE it is published.
// A document whose env is not the brain's own, or whose serial is lower than the one held (a stale CDN edge), is
// refused whole. When CloudFront is unreachable the brain keeps its last copy.
//
// Node 16 has no global fetch: the default fetcher is https.get.

const https = require('https');
const { floorFor } = require('./remoteSchema');

const POLL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;

// The compiled defaults: the open gates and the server values of spec 4.5's example document.
function defaultView(env) {
  return {
    env,
    serial: -1,
    source: 'defaults',
    fetched_at: null,
    gates: {
      min_build: { default: 0 },
      min_build_multiplayer: { default: 0 },
      min_wire: 1,
      maintenance: { active: false, scope: 'multiplayer', title: '', message: '', ends_at: null },
    },
    flags: { multiplayer: true, quickplay: true, private_lobbies: true, account_creation: true },
    messages: {},
    server: {
      admission: { enabled: false, rate_per_min: 600, burst: 50, grant_ttl_sec: 120, ticket_ttl_sec: 600,
        session_refresh_grace_sec: 86400 },
      lobby_queue_max: 200,
      rate_limits: { login_per_min_ip: 10, login_per_min_account: 5, restore_per_min_credential: 30 },
    },
  };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function intIn(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

// Merges `doc` over `prev` field by field. Returns { view, rejected: [path: why] }.
function mergeDocument(prev, doc) {
  const rejected = [];
  const view = JSON.parse(JSON.stringify(prev));
  const reject = (path, why) => rejected.push(`${path}: ${why}`);

  const takeInt = (obj, key, target, tkey, lo, hi, path) => {
    if (!(key in obj)) return;
    if (intIn(obj[key], lo, hi)) target[tkey] = obj[key];
    else reject(path, `must be an integer in ${lo}..${hi}`);
  };
  const takeBool = (obj, key, target, path) => {
    if (!(key in obj)) return;
    if (typeof obj[key] === 'boolean') target[key] = obj[key];
    else reject(path, 'must be true or false');
  };
  const takeString = (obj, key, target, path, max = 280) => {
    if (!(key in obj)) return;
    if (typeof obj[key] === 'string' && obj[key].length <= max) target[key] = obj[key];
    else reject(path, `must be a string of at most ${max} characters`);
  };

  const g = doc.gates;
  if (isObject(g)) {
    for (const name of ['min_build', 'min_build_multiplayer']) {
      if (!(name in g)) continue;
      if (!isObject(g[name])) {
        reject(`gates.${name}`, 'must be an object');
        continue;
      }
      const gate = {};
      for (const [k, v] of Object.entries(g[name])) {
        if (intIn(v, 0, Number.MAX_SAFE_INTEGER)) gate[k] = v;
        else reject(`gates.${name}.${k}`, 'must be a non-negative integer');
      }
      if (!('default' in gate)) gate.default = floorFor(view.gates[name], 'default');
      view.gates[name] = gate;
    }
    takeInt(g, 'min_wire', view.gates, 'min_wire', 0, Number.MAX_SAFE_INTEGER, 'gates.min_wire');
    if ('maintenance' in g) {
      const m = g.maintenance;
      if (!isObject(m)) reject('gates.maintenance', 'must be an object');
      else {
        const target = view.gates.maintenance;
        takeBool(m, 'active', target, 'gates.maintenance.active');
        if ('scope' in m) {
          if (m.scope === 'multiplayer' || m.scope === 'app') target.scope = m.scope;
          else reject('gates.maintenance.scope', 'must be multiplayer or app');
        }
        takeString(m, 'title', target, 'gates.maintenance.title');
        takeString(m, 'message', target, 'gates.maintenance.message');
        if ('ends_at' in m) {
          if (m.ends_at === null || (typeof m.ends_at === 'string' && !Number.isNaN(Date.parse(m.ends_at)))) target.ends_at = m.ends_at;
          else reject('gates.maintenance.ends_at', 'must be null or an ISO 8601 time');
        }
      }
    }
  } else if ('gates' in doc) reject('gates', 'must be an object');

  if (isObject(doc.flags)) {
    for (const k of Object.keys(view.flags)) takeBool(doc.flags, k, view.flags, `flags.${k}`);
  } else if ('flags' in doc) reject('flags', 'must be an object');

  if (isObject(doc.messages)) {
    const messages = {};
    for (const [code, m] of Object.entries(doc.messages)) {
      const path = `messages.${code}`;
      if (!/^[A-Z][A-Z0-9_]*$/.test(code) || !isObject(m) || typeof m.message !== 'string' || m.message.trim() === '') {
        reject(path, 'must be {message, title?, action?} under an UPPER_SNAKE code');
        continue;
      }
      const out = { message: m.message };
      if (typeof m.title === 'string') out.title = m.title;
      if (isObject(m.action) && typeof m.action.kind === 'string') {
        out.action = { kind: m.action.kind };
        if (typeof m.action.label === 'string') out.action.label = m.action.label;
        if (typeof m.action.url === 'string' && /^https:\/\//.test(m.action.url)) out.action.url = m.action.url;
      }
      messages[code] = out;
    }
    view.messages = messages;
  } else if ('messages' in doc) reject('messages', 'must be an object');

  const s = doc.server;
  if (isObject(s)) {
    if (isObject(s.admission)) {
      const a = s.admission;
      const t = view.server.admission;
      takeBool(a, 'enabled', t, 'server.admission.enabled');
      takeInt(a, 'rate_per_min', t, 'rate_per_min', 1, 100000, 'server.admission.rate_per_min');
      takeInt(a, 'burst', t, 'burst', 1, 100000, 'server.admission.burst');
      takeInt(a, 'grant_ttl_sec', t, 'grant_ttl_sec', 10, 3600, 'server.admission.grant_ttl_sec');
      takeInt(a, 'ticket_ttl_sec', t, 'ticket_ttl_sec', 30, 86400, 'server.admission.ticket_ttl_sec');
      takeInt(a, 'session_refresh_grace_sec', t, 'session_refresh_grace_sec', 0, 604800, 'server.admission.session_refresh_grace_sec');
    } else if ('admission' in s) reject('server.admission', 'must be an object');
    takeInt(s, 'lobby_queue_max', view.server, 'lobby_queue_max', 0, 100000, 'server.lobby_queue_max');
    if (isObject(s.rate_limits)) {
      for (const k of ['login_per_min_ip', 'login_per_min_account', 'restore_per_min_credential']) {
        takeInt(s.rate_limits, k, view.server.rate_limits, k, 1, 100000, `server.rate_limits.${k}`);
      }
    } else if ('rate_limits' in s) reject('server.rate_limits', 'must be an object');
  } else if ('server' in doc) reject('server', 'must be an object');

  return { view, rejected };
}

// Whether a fetched document may replace `current` at all. Returns null, or why not.
function refuseDocument(current, doc) {
  if (!isObject(doc)) return 'not a JSON object';
  if (doc.schema !== 1) return `schema is ${JSON.stringify(doc.schema)}, not 1`;
  if (doc.env !== current.env) return `env is ${JSON.stringify(doc.env)}, not this brain's ${current.env}`;
  if (!Number.isInteger(doc.serial)) return 'serial is not an integer';
  if (doc.serial < current.serial) return `serial ${doc.serial} is older than the ${current.serial} held (a stale edge)`;
  return null;
}

function httpsGetJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error(`larger than ${MAX_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('not JSON'));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

// createRemoteConfig({ env, url, fetchJson, log, now }) -> { current(), refresh(), start(), stop() }
function createRemoteConfig({ env, url, fetchJson = httpsGetJson, log = require('../log'), now = () => Date.now(),
  pollMs = POLL_MS } = {}) {
  let view = defaultView(env);
  let timer = null;

  async function refresh() {
    if (!url) return view;
    let doc;
    try {
      doc = await fetchJson(url);
    } catch (e) {
      log.warn(`[CONFIG] fetch failed (${e.message}); keeping serial ${view.serial} (${view.source})`);
      return view;
    }
    const why = refuseDocument(view, doc);
    if (why) {
      log.warn(`[CONFIG] refused the fetched document: ${why}`);
      return view;
    }
    const { view: next, rejected } = mergeDocument(view, doc);
    for (const r of rejected) log.warn(`[CONFIG] rejected ${r}`);
    next.serial = doc.serial;
    next.source = 'fetched';
    next.fetched_at = new Date(now()).toISOString();
    if (doc.serial !== view.serial) log.info(`[CONFIG] serial ${doc.serial} (${env})`);
    view = next;
    return view;
  }

  return {
    current: () => view,
    refresh,
    // The first fetch, bounded by its own timeout; then every pollMs. Never throws.
    async start() {
      if (!url) log.warn('[CONFIG] CONFIG_URL is not set: the gates and limits are the compiled defaults');
      await refresh();
      if (url && !timer) {
        timer = setInterval(() => { refresh(); }, pollMs);
        timer.unref();
      }
      return view;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Tests only: hold this view as if fetched.
    _set(v) {
      view = v;
    },
  };
}

module.exports = { createRemoteConfig, defaultView, mergeDocument, refuseDocument, httpsGetJson, POLL_MS };
