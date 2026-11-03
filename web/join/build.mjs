// Builds the invite link site (RJ 458; Wobble Planet specs/invite-links.md, 5) from web/join/site.json alone:
//
//   node web/join/build.mjs --out <dir> [--site <file>] [--preview-api <http(s)://host:port>]
//
//   index.html                              the page (index.template.html with the site's values, and a CSP whose
//                                           hashes are the inline script's and style's)
//   .well-known/assetlinks.json             each Android package with every known SHA-256 fingerprint
//   .well-known/apple-app-site-association  Team ID + bundle id, every path; no details while either is unknown
//   robots.txt                              nothing to index: every page is someone's invite
//   assets/<file>                           every file of web/join/assets (the page's fonts), as it is
//
// stdout: one line per file, "FILE <key> <content type> <cache control>" (ops/join/publish.sh uploads with exactly
// these), then "UNKNOWN <field>" for each null in site.json. A malformed value (a fingerprint, a URL, an id) stops
// the build, exit 1, naming each. --preview-api points both environments' lookups at one local stand-in, for looking
// at the page on this machine; publish.sh never passes it.
//
// No dependencies: Node's own fs, path and crypto (Node 20).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const PAGE_CACHE = 'public, max-age=300';
const WELL_KNOWN_CACHE = 'public, max-age=3600';
const ASSET_CACHE = 'public, max-age=604800';
const ASSET_TYPES = Object.freeze({
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
});
const ASSET_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function isHttps(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch (e) {
    return false;
  }
}

function sha256b64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

// Every problem with site.json, and every value it does not know yet (null), by dotted path.
export function checkSite(site) {
  const problems = [];
  const unknown = [];
  const at = (p, ok, why) => { if (!ok) problems.push(`${p}: ${why}`); };
  const known = (p, v) => {
    if (v === null) {
      unknown.push(p);
      return false;
    }
    return true;
  };
  at('host', typeof site.host === 'string' && HOST_RE.test(site.host), 'must be a host name');
  for (const env of ['alpha', 'dev']) {
    at(`api.${env}`, site.api && isHttps(site.api[env]) && new URL(site.api[env]).pathname === '/', 'must be an https origin');
    const a = site.android && site.android[env];
    at(`android.${env}.package`, a && typeof a.package === 'string' && PACKAGE_RE.test(a.package), 'must be an Android package name');
    const prints = (a && a.sha256) || {};
    let any = false;
    for (const [name, fp] of Object.entries(prints)) {
      if (!known(`android.${env}.sha256.${name}`, fp)) continue;
      at(`android.${env}.sha256.${name}`, typeof fp === 'string' && FINGERPRINT_RE.test(fp), 'must be 32 upper-case hex bytes joined by colons');
      any = true;
    }
    at(`android.${env}.sha256`, any, 'needs at least one known fingerprint: without one the app cannot verify the domain');
  }
  const ios = site.ios || {};
  if (known('ios.team_id', ios.team_id)) at('ios.team_id', typeof ios.team_id === 'string' && TEAM_ID_RE.test(ios.team_id), 'must be 10 upper-case letters and digits');
  if (known('ios.bundle_id', ios.bundle_id)) at('ios.bundle_id', typeof ios.bundle_id === 'string' && BUNDLE_ID_RE.test(ios.bundle_id), 'must be a bundle id');
  if (known('ios.testflight_url', ios.testflight_url)) at('ios.testflight_url', isHttps(ios.testflight_url), 'must be an https URL');
  for (const k of ['testers_group_url', 'play_testing_url', 'play_store_url']) {
    if (known(k, site[k])) at(k, isHttps(site[k]), 'must be an https URL');
  }
  return { problems, unknown };
}

export function assetLinks(site) {
  const out = [];
  for (const env of ['alpha', 'dev']) {
    const a = site.android[env];
    const prints = Object.values(a.sha256 || {}).filter((fp) => fp !== null);
    if (!prints.length) continue;
    out.push({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: a.package, sha256_cert_fingerprints: prints },
    });
  }
  return out;
}

// Every path is the app's (spec 5: "/* paths"); "paths" for iOS before 13, "components" after.
export function appleAppSiteAssociation(site) {
  const { team_id: team, bundle_id: bundle } = site.ios;
  if (!team || !bundle) return { applinks: { apps: [], details: [] } };
  const appID = `${team}.${bundle}`;
  return { applinks: { apps: [], details: [{ appID, appIDs: [appID], paths: ['*'], components: [{ '/': '/*' }] }] } };
}

// The page: the template with what the script needs from site.json, and its Content-Security-Policy.
export function page(site, { template = fs.readFileSync(path.join(HERE, 'index.template.html'), 'utf8'), previewApi = null } = {}) {
  const api = previewApi ? { alpha: previewApi, dev: previewApi } : site.api;
  const pageSite = {
    host: site.host,
    api,
    android: { alpha: { package: site.android.alpha.package }, dev: { package: site.android.dev.package } },
    ios: { testflight_url: site.ios.testflight_url || null },
    testers_group_url: site.testers_group_url,
    play_testing_url: site.play_testing_url,
    play_store_url: site.play_store_url,
  };
  if (!template.includes('/*@SITE@*/null') || !template.includes('<!--@CSP@-->')) throw new Error('index.template.html has lost a marker');
  // JSON inside a <script>: "<" escaped, so no value can close the element.
  const json = JSON.stringify(pageSite).replace(/</g, '\\u003c');
  let html = template.replace('/*@SITE@*/null', () => json);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!script || !style) throw new Error('index.template.html needs one inline <script> and one <style>');
  const connect = [...new Set(Object.values(api).map((u) => new URL(u).origin))].join(' ');
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256b64(script[1])}'`,
    `style-src 'sha256-${sha256b64(style[1])}'`,
    "font-src 'self'",
    `connect-src ${connect}`,
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  html = html.replace('<!--@CSP@-->', () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  return { html, csp, pageSite };
}

// web/join/assets, as files to serve under assets/: a name it cannot serve (a type it does not know, a dotfile, a
// directory) stops the build.
export function assetFiles(dir = path.join(HERE, 'assets')) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((name) => {
    const type = ASSET_TYPES[path.extname(name).toLowerCase()];
    if (!ASSET_NAME_RE.test(name) || !type || !fs.statSync(path.join(dir, name)).isFile()) {
      throw new Error(`web/join/assets/${name}: not a file this site serves (${Object.keys(ASSET_TYPES).join(', ')})`);
    }
    return { key: `assets/${name}`, body: fs.readFileSync(path.join(dir, name)), contentType: type, cacheControl: ASSET_CACHE };
  });
}

// Everything the site serves: [{key, body, contentType, cacheControl}], plus what is unknown. Throws on a problem.
export function buildSite(site, opts = {}) {
  const { problems, unknown } = checkSite(site);
  if (problems.length) {
    const e = new Error(`web/join/site.json is not valid:\n  - ${problems.join('\n  - ')}`);
    e.problems = problems;
    throw e;
  }
  const files = [
    { key: 'index.html', body: page(site, opts).html, contentType: 'text/html; charset=utf-8', cacheControl: PAGE_CACHE },
    { key: '.well-known/assetlinks.json', body: `${JSON.stringify(assetLinks(site), null, 2)}\n`, contentType: 'application/json', cacheControl: WELL_KNOWN_CACHE },
    // No extension: its type is set explicitly, as Apple requires.
    { key: '.well-known/apple-app-site-association', body: `${JSON.stringify(appleAppSiteAssociation(site), null, 2)}\n`, contentType: 'application/json', cacheControl: WELL_KNOWN_CACHE },
    { key: 'robots.txt', body: 'User-agent: *\nDisallow: /\n', contentType: 'text/plain; charset=utf-8', cacheControl: PAGE_CACHE },
    ...assetFiles(opts.assetsDir),
  ];
  return { files, unknown };
}

function main(argv) {
  let out = null;
  let sitePath = path.join(HERE, 'site.json');
  let previewApi = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--site') sitePath = argv[++i];
    else if (argv[i] === '--preview-api') previewApi = argv[++i];
    else throw new Error(`build.mjs: unknown argument ${argv[i]}`);
  }
  if (!out) throw new Error('build.mjs: --out <dir> is required');
  if (previewApi !== null && !/^https?:\/\/[^/]+$/.test(previewApi)) throw new Error('--preview-api takes an origin, http(s)://host:port');
  const site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));
  const { files, unknown } = buildSite(site, { previewApi });
  for (const f of files) {
    const dest = path.join(out, f.key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.body);
    console.log(`FILE ${f.key} ${f.contentType.replace(/ /g, '')} ${f.cacheControl.replace(/ /g, '')}`);
  }
  for (const u of unknown) console.log(`UNKNOWN ${u}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
