'use strict';
// RJ 458's draft invite link page (web/join; on hold while its home is decided): what build.mjs makes from site.json,
// and the page's own logic, run from the built file: the path, the platform (iPadOS's Mac user agent included), one
// platform's steps only, the switch to the other, and each outcome's text.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE_FILE = path.join(__dirname, '..', 'web', 'join', 'site.json');
const site = () => JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
const build = () => import('../web/join/build.mjs');

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipados: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

async function pageApi(s = site()) {
  const { page } = await build();
  const { html, csp } = page(s);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = {};
  vm.runInNewContext(script, ctx);
  // Plain objects of this realm, so deepStrictEqual compares values, not prototypes.
  const RJ = {};
  for (const [k, fn] of Object.entries(ctx.RJJoin)) RJ[k] = (...a) => JSON.parse(JSON.stringify(fn(...a)));
  return { RJ, html, csp, script };
}

const text = (v) => JSON.stringify(v);

test('site.json builds: both packages\' fingerprints, an empty iOS association until its values are known, the unknowns listed', async () => {
  const { buildSite, appleAppSiteAssociation } = await build();
  const { files, unknown } = buildSite(site());
  assert.deepEqual(files.map((f) => [f.key, f.contentType]), [
    ['index.html', 'text/html; charset=utf-8'],
    ['.well-known/assetlinks.json', 'application/json'],
    ['.well-known/apple-app-site-association', 'application/json'],
    ['robots.txt', 'text/plain; charset=utf-8'],
    ['assets/akira-expanded.otf', 'font/otf'],
    ['assets/michroma-regular.ttf', 'font/ttf'],
  ]);
  for (const f of files.slice(4)) {
    assert.ok(Buffer.isBuffer(f.body) && f.body.length > 10000, f.key);
    assert.ok(files[0].body.includes(`url('/${f.key}')`), `the page uses ${f.key}`);
  }
  const links = JSON.parse(files[1].body);
  assert.deepEqual(links.map((l) => l.target.package_name), ['com.riftjumpers.game', 'com.riftjumpers.game.dev']);
  for (const l of links) {
    assert.deepEqual(l.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(l.target.namespace, 'android_app');
    for (const fp of l.target.sha256_cert_fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
  assert.deepEqual(JSON.parse(files[2].body), { applinks: { apps: [], details: [] } });
  assert.deepEqual(unknown, ['android.alpha.sha256.upload', 'ios.team_id', 'ios.alpha.bundle_id', 'ios.dev.bundle_id', 'ios.testflight_url']);
  assert.equal(files[3].body, 'User-agent: *\nDisallow: /\n');
});

// Apple's matching for one app's details (iOS 13 "components", path rules only): the first rule whose pattern matches
// decides, and an exclude rule means "not this app". * matches any run of characters, ? one.
function claims(detail, urlPath) {
  for (const c of detail.components) {
    const re = new RegExp(`^${c['/'].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    if (re.test(urlPath)) return !c.exclude;
  }
  return false;
}

test('apple-app-site-association: each iOS app claims only its own links -- dev /dev/*, release everything else', async () => {
  const { appleAppSiteAssociation, buildSite } = await build();
  const known = site();
  known.ios = { team_id: 'ABCDE12345', alpha: { bundle_id: 'com.riftjumpers.game' }, dev: { bundle_id: 'com.riftjumpers.game.dev' }, testflight_url: null };
  const { details } = appleAppSiteAssociation(known).applinks;
  assert.deepEqual(details, [
    {
      appID: 'ABCDE12345.com.riftjumpers.game', appIDs: ['ABCDE12345.com.riftjumpers.game'],
      paths: ['NOT /dev/*', '*'], components: [{ '/': '/dev/*', exclude: true }, { '/': '/*' }],
    },
    {
      appID: 'ABCDE12345.com.riftjumpers.game.dev', appIDs: ['ABCDE12345.com.riftjumpers.game.dev'],
      paths: ['/dev/*'], components: [{ '/': '/dev/*' }],
    },
  ]);
  const [release, dev] = details;
  for (const p of ['/ab23cd45ef', '/AB23CD45EF', '/ab23cd45ef/']) {
    assert.deepEqual([claims(release, p), claims(dev, p)], [true, false], `${p}: the release app's alone`);
  }
  for (const p of ['/dev/ab23cd45ef', '/dev/ab23cd45ef/']) {
    assert.deepEqual([claims(release, p), claims(dev, p)], [false, true], `${p}: the dev app's alone`);
  }
  // The exclude must come first: Apple stops at the first rule that matches.
  assert.equal(release.components[0].exclude, true);
  // The rules hold in the built file as written.
  const aasa = JSON.parse(buildSite(known).files.find((f) => f.key === '.well-known/apple-app-site-association').body);
  assert.deepEqual(aasa.applinks.details, details);

  // One app known: only it is listed; no Team ID: none.
  const one = site();
  one.ios = { team_id: 'ABCDE12345', alpha: { bundle_id: null }, dev: { bundle_id: 'com.riftjumpers.game.dev' }, testflight_url: null };
  assert.deepEqual(appleAppSiteAssociation(one).applinks.details.map((d) => d.appID), ['ABCDE12345.com.riftjumpers.game.dev']);
  const noTeam = site();
  noTeam.ios = { ...known.ios, team_id: null };
  assert.deepEqual(appleAppSiteAssociation(noTeam).applinks.details, []);
  // The same bundle id for both would claim every link in one app.
  const same = site();
  same.ios = { team_id: 'ABCDE12345', alpha: { bundle_id: 'com.riftjumpers.game' }, dev: { bundle_id: 'com.riftjumpers.game' }, testflight_url: null };
  assert.throws(() => buildSite(same), /ios\.dev\.bundle_id: must not be the release bundle id/);
  // The old single bundle_id is refused, not silently read as no app.
  const old = site();
  old.ios = { team_id: 'ABCDE12345', bundle_id: 'com.riftjumpers.game', testflight_url: null };
  assert.throws(() => buildSite(old), /ios\.alpha\.bundle_id: missing/);
});

test('a malformed value stops the build, naming it', async () => {
  const { buildSite } = await build();
  const none = site();
  none.android.dev.sha256 = { debug: null };
  assert.throws(() => buildSite(none), /android\.dev\.sha256: needs at least one known fingerprint/);
  const bad = site();
  bad.android.alpha.sha256.play_app_signing = '25:7b:cb';
  bad.ios.team_id = 'lower';
  bad.testers_group_url = 'http://groups.google.com/x';
  assert.throws(() => buildSite(bad), (e) => {
    assert.deepEqual(e.problems.map((p) => p.split(':')[0]).sort(),
      ['android.alpha.sha256.play_app_signing', 'ios.team_id', 'testers_group_url']);
    return true;
  });
});

test('the page: its CSP allows exactly its inline script and style, and the two lookups; a value cannot close the script', async () => {
  const { html, csp, script } = await pageApi();
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${h(script)}'`));
  assert.ok(csp.includes(`style-src 'sha256-${h(style)}'`));
  assert.ok(csp.includes('connect-src https://api.riftjumpers.space https://api-dev.riftjumpers.space'));
  assert.ok(csp.includes("font-src 'self'"), 'the fonts are bundled, nothing is fetched from a font host');
  assert.doesNotMatch(html, /googleapis|gstatic/);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'), 'the invite in the path never leaves as a Referer');
  const evil = site();
  evil.play_store_url = 'https://example.test/</script><script>alert(1)</script>';
  const { page } = await build();
  const out = page(evil).html;
  assert.equal(out.match(/<\/script>/g).length, 1);
});

test('the path: /<id> is alpha, /dev/<id> is dev, case-blind; anything else has no id', async () => {
  const { RJ } = await pageApi();
  assert.deepEqual(RJ.parsePath('/ab23cd45ef'), { env: 'alpha', id: 'ab23cd45ef' });
  assert.deepEqual(RJ.parsePath('/dev/AB23CD45EF/'), { env: 'dev', id: 'ab23cd45ef' });
  for (const p of ['/', '', '/dev', '/dev/', '/ab23cd45e', '/ab23cd45ef/x', '/x/ab23cd45ef', '/%E0%A4%A', '/ab23cd45e0']) {
    assert.equal(RJ.parsePath(p).id, null, p);
  }
});

test('the platform from the user agent: Android, iPhone, iPadOS (a Mac with touch points), else desktop', async () => {
  const { RJ } = await pageApi();
  assert.equal(RJ.platformOf(UA.android, 5), 'android');
  assert.equal(RJ.platformOf(UA.iphone, 5), 'ios');
  assert.equal(RJ.platformOf(UA.ipados, 5), 'ios');
  assert.equal(RJ.platformOf(UA.ipados, 0), 'desktop', 'a real Mac');
  assert.equal(RJ.platformOf(UA.windows, 0), 'desktop');
  assert.equal(RJ.platformOf(undefined, undefined), 'desktop');
});

test('valid, Android: the name, Open the game for the release package, the four steps, the account warning, one switch', async () => {
  const { RJ } = await pageApi();
  const v = RJ.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'android', lookup: 'valid', inviter: 'nova' });
  assert.equal(v.title, 'nova invited you to play Rift Jumpers');
  assert.equal(v.open, `intent://join.riftjumpers.space/ab23cd45ef#Intent;scheme=https;package=com.riftjumpers.game;S.browser_fallback_url=${encodeURIComponent('https://join.riftjumpers.space/ab23cd45ef#install')};end`);
  assert.deepEqual(v.steps.map((s) => s.href), [
    'https://groups.google.com/g/rift-jumpers-alpha',
    'https://play.google.com/apps/testing/com.riftjumpers.game',
    'https://play.google.com/store/apps/details?id=com.riftjumpers.game',
  ]);
  assert.match(v.steps[0].how, /Join group at the top/);
  assert.match(v.steps[0].how, /joining the group/);
  assert.equal(v.warn, 'Use the same Google account for steps 1 and 2 as the Play Store on this phone.');
  assert.equal(v.again, 'Installed? Tap your invite link again.');
  assert.deepEqual(v.switches, [{ platform: 'ios', label: 'On an iPhone instead?' }]);
  assert.doesNotMatch(text(v), /TestFlight|iPhone for|coming soon/, 'no iPhone steps on Android');
});

test('valid, iPhone: Open the game by the riftjumpers:// scheme; TestFlight when known, else coming soon; no Android steps; the switch back', async () => {
  const { RJ } = await pageApi();
  const v = RJ.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'ios', lookup: 'valid', inviter: 'nova' });
  assert.equal(v.title, 'nova invited you to play Rift Jumpers');
  assert.equal(v.name, 'nova');
  assert.equal(v.lead, 'Rift Jumpers for iPhone is coming soon.');
  assert.equal(v.open, 'riftjumpers://join/ab23cd45ef');
  assert.equal(v.steps, undefined);
  assert.deepEqual(v.switches, [{ platform: 'android', label: 'On Android instead?' }]);
  assert.doesNotMatch(text(v), /Google|Play|groups/, 'no Android steps on an iPhone');

  const s = site();
  s.ios.testflight_url = 'https://testflight.apple.com/join/AbCdEf12';
  const { RJ: RJ2 } = await pageApi(s);
  const w = RJ2.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'ios', lookup: 'valid', inviter: 'nova' });
  assert.deepEqual(w.steps.map((st) => st.href), ['https://apps.apple.com/app/testflight/id899247664', 'https://testflight.apple.com/join/AbCdEf12']);
  assert.equal(w.steps[1].how, 'Tap Accept, then Install.');
  assert.equal(w.again, 'Installed? Tap your invite link again.');
});

test('the game missing: Chrome\'s #install fallback says so; an Open that left the page in front says it may be; iPhone before TestFlight says not out yet', async () => {
  const { RJ } = await pageApi();
  const base = { env: 'alpha', id: 'ab23cd45ef', lookup: 'valid', inviter: 'nova' };
  assert.equal(RJ.view({ ...base, platform: 'android' }).missing, undefined, 'nothing until Open the game was tried');
  assert.equal(RJ.view({ ...base, platform: 'android', installHint: true }).missing,
    "The game isn't on this phone yet. Get it below, then tap your invite link again.");
  const stalled = RJ.view({ ...base, platform: 'android', openStalled: true });
  assert.equal(stalled.missing, "Didn't open? The game may not be on this phone yet. Get it below, then tap your invite link again.");
  assert.equal(stalled.steps.length, 3, 'the steps stay');
  assert.equal(RJ.view({ ...base, env: 'dev', platform: 'android', installHint: true }).missing,
    "The game isn't on this phone yet.", 'no steps to point at on a dev link');
  assert.equal(RJ.view({ ...base, platform: 'ios', openStalled: true }).missing,
    "The game didn't open: Rift Jumpers for iPhone isn't out yet.");
  const s = site();
  s.ios.testflight_url = 'https://testflight.apple.com/join/AbCdEf12';
  const { RJ: RJ2 } = await pageApi(s);
  assert.match(RJ2.view({ ...base, platform: 'ios', openStalled: true }).missing, /^Didn't open\? .* Get it below/);
  assert.equal(RJ.view({ ...base, platform: 'desktop', openStalled: true }).missing, undefined);
});

test('desktop, dev links, an expired invite, and a lookup that failed', async () => {
  const { RJ } = await pageApi();
  const d = RJ.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'desktop', lookup: 'valid', inviter: 'nova' });
  assert.deepEqual([d.lead, d.steps, d.open], ['Open this link on your phone.', undefined, undefined]);
  assert.deepEqual(d.switches.map((x) => x.platform), ['android', 'ios']);

  const dev = RJ.view({ env: 'dev', id: 'ab23cd45ef', platform: 'android', lookup: 'valid', inviter: 'vega' });
  assert.match(dev.open, /^intent:\/\/join\.riftjumpers\.space\/dev\/ab23cd45ef#Intent;scheme=https;package=com\.riftjumpers\.game\.dev;/);
  assert.equal(dev.steps, undefined, 'dev builds come from the Drive folder: no sign-up steps');
  const devIos = RJ.view({ env: 'dev', id: 'ab23cd45ef', platform: 'ios', lookup: 'valid', inviter: 'vega' });
  assert.deepEqual([devIos.open, devIos.steps, devIos.lead], ['riftjumpers://join/dev/ab23cd45ef', undefined, undefined]);

  for (const state of [{ env: 'alpha', id: null, platform: 'android' }, { env: 'alpha', id: 'ab23cd45ef', platform: 'ios', lookup: 'invalid' }]) {
    const x = RJ.view(state);
    assert.equal(x.title, 'This invite has expired; ask your friend for a new one.');
    assert.deepEqual([x.steps, x.open, x.switches], [undefined, undefined, []], 'no sign-up links');
  }

  const err = RJ.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'android', lookup: 'error' });
  assert.equal(err.title, "You've been invited to play Rift Jumpers");
  assert.match(err.notes[0], /couldn't check this invite/);
  assert.ok(err.open && err.steps.length === 3, 'still a way into the game');
});
