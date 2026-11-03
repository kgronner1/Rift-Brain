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
  ]);
  const links = JSON.parse(files[1].body);
  assert.deepEqual(links.map((l) => l.target.package_name), ['com.riftjumpers.game', 'com.riftjumpers.game.dev']);
  for (const l of links) {
    assert.deepEqual(l.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(l.target.namespace, 'android_app');
    for (const fp of l.target.sha256_cert_fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
  assert.deepEqual(JSON.parse(files[2].body), { applinks: { apps: [], details: [] } });
  assert.deepEqual(unknown, ['android.alpha.sha256.upload', 'ios.team_id', 'ios.bundle_id', 'ios.testflight_url']);
  const known = { ...site(), ios: { team_id: 'ABCDE12345', bundle_id: 'com.riftjumpers.game', testflight_url: null } };
  assert.deepEqual(appleAppSiteAssociation(known).applinks.details, [
    { appID: 'ABCDE12345.com.riftjumpers.game', appIDs: ['ABCDE12345.com.riftjumpers.game'], paths: ['*'], components: [{ '/': '/*' }] },
  ]);
  assert.equal(files[3].body, 'User-agent: *\nDisallow: /\n');
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

test('valid, iPhone: TestFlight when known, else coming soon; no Android steps; the switch back', async () => {
  const { RJ } = await pageApi();
  const v = RJ.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'ios', lookup: 'valid', inviter: 'nova' });
  assert.equal(v.title, 'nova invited you to play Rift Jumpers');
  assert.equal(v.lead, 'Rift Jumpers for iPhone is coming soon.');
  assert.equal(v.open, undefined);
  assert.equal(v.steps, undefined);
  assert.deepEqual(v.switches, [{ platform: 'android', label: 'On Android instead?' }]);
  assert.doesNotMatch(text(v), /Google|Play|groups/, 'no Android steps on an iPhone');

  const s = site();
  s.ios.testflight_url = 'https://testflight.apple.com/join/AbCdEf12';
  const { RJ: RJ2 } = await pageApi(s);
  const w = RJ2.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'ios', lookup: 'valid', inviter: 'nova' });
  assert.deepEqual(w.steps, [{ text: 'Install Rift Jumpers with TestFlight', href: 'https://testflight.apple.com/join/AbCdEf12' }]);
  assert.equal(w.again, 'Installed? Tap your invite link again.');
});

test('desktop, dev links, an expired invite, and a lookup that failed', async () => {
  const { RJ } = await pageApi();
  const d = RJ.view({ env: 'alpha', id: 'ab23cd45ef', platform: 'desktop', lookup: 'valid', inviter: 'nova' });
  assert.deepEqual([d.lead, d.steps, d.open], ['Open this link on your phone.', undefined, undefined]);
  assert.deepEqual(d.switches.map((x) => x.platform), ['android', 'ios']);

  const dev = RJ.view({ env: 'dev', id: 'ab23cd45ef', platform: 'android', lookup: 'valid', inviter: 'vega' });
  assert.match(dev.open, /^intent:\/\/join\.riftjumpers\.space\/dev\/ab23cd45ef#Intent;scheme=https;package=com\.riftjumpers\.game\.dev;/);
  assert.equal(dev.steps, undefined, 'dev builds come from the Drive folder: no sign-up steps');

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
