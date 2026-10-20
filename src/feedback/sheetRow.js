'use strict';
// A feedback row as the Player Feedback sheet shows it (RJ 489), keyed by the sheet's header names, which the Apps
// Script (ops/feedback/apps_script.gs) looks up in row 1. Pure.
//
// Everything is a string but Build (a number, or ''). The script turns Received and Written into dates and writes every
// string as plain text, so nothing a player typed can become a formula. Triage and Notes are Alex's and are never
// sent.

const HEADERS = Object.freeze(['Received', 'Written', 'Env', 'Tags', 'Feedback', 'Player', 'Where', 'Build', 'Platform',
  'Device', 'Run / match', 'Feedback ID', 'Context', 'Triage', 'Notes']);
const LEAF_MAX = 120;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function leaf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).slice(0, LEAF_MAX).trim();
}

function parseContext(text) {
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : {};
  } catch (e) {
    return {};
  }
}

// "Pixel 8 · Android 14 · 1080x2400 · en"
function deviceText(d) {
  if (!isObject(d)) return '';
  const os = [leaf(d.os), leaf(d.os_version)].filter(Boolean).join(' ');
  const screen = Array.isArray(d.screen) && d.screen.length === 2 ? `${leaf(d.screen[0])}x${leaf(d.screen[1])}` : '';
  return [leaf(d.model), os, screen, leaf(d.locale)].filter(Boolean).join(' · ');
}

// "TimeTrial n3 · level 4 · seed 4242 · 81.2 s" or "lobby ABCD · 3 players · pregame"
function runText(ctx) {
  if (isObject(ctx.run)) {
    const r = ctx.run;
    const parts = [[leaf(r.mission), leaf(r.node)].filter(Boolean).join(' ')];
    if (leaf(r.level) !== '') parts.push(`level ${leaf(r.level)}`);
    if (leaf(r.seed) !== '') parts.push(`seed ${leaf(r.seed)}`);
    if (typeof r.run_sec === 'number' && Number.isFinite(r.run_sec)) parts.push(`${Math.round(r.run_sec * 10) / 10} s`);
    return parts.filter(Boolean).join(' · ');
  }
  if (isObject(ctx.match)) {
    const m = ctx.match;
    const parts = [];
    if (leaf(m.lobby) !== '') parts.push(`lobby ${leaf(m.lobby)}`);
    if (leaf(m.players) !== '') parts.push(`${leaf(m.players)} players`);
    if (leaf(m.phase) !== '') parts.push(leaf(m.phase));
    return parts.join(' · ');
  }
  return '';
}

function playerText(r) {
  if (r.anonymized_at) return 'deleted account';
  if (r.user_id === null || r.user_id === undefined) return 'anonymous';
  return r.username ? `${r.username} (#${r.user_id})` : `#${r.user_id}`;
}

// r: a row from the sheet store (storage/feedback.js). Returns { header: value } for the sheet's own columns.
function sheetRow(r) {
  const ctx = parseContext(r.context);
  return {
    Received: r.received_at,
    Written: r.written_at || '',
    Env: r.env,
    Tags: String(r.tags || '').split(',').filter(Boolean).join(', '),
    Feedback: r.message,
    Player: playerText(r),
    Where: leaf(ctx.where),
    Build: Number.isInteger(r.build) ? r.build : '',
    Platform: r.platform || '',
    Device: deviceText(ctx.device),
    'Run / match': runText(ctx),
    'Feedback ID': r.id,
    Context: typeof r.context === 'string' ? r.context : JSON.stringify(r.context || {}),
  };
}

module.exports = { sheetRow, playerText, deviceText, runText, HEADERS };
