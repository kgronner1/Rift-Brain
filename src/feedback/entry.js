'use strict';
// A player's feedback entry (RJ 488, POST /v1/feedback), cleaned. Pure.
//
// Only a malformed entry is refused (VALIDATION): one no honest client can send, so the client may delete it. Every
// other oddity is repaired instead, because a refusal costs the player's note:
//   id          a UUID (any version: a strict v4 check would refuse a whole client build over its generator)
//   message     a string, trimmed, cut to MESSAGE_MAX code points (Godot's length()); empty after trimming is refused
//   tags        unknown tags, non-strings and duplicates dropped, case ignored, kept in TAGS order; not an array -> []
//   written_at  a string cut to 40 characters; anything else -> null
//   context     an object, capped at CONTEXT_MAX_BYTES serialised (see capContext); anything else -> {}

const { fail } = require('../contract/envelope');

const MESSAGE_MAX = 2000;
const WRITTEN_AT_MAX = 40;
const CONTEXT_MAX_BYTES = 4096;
const TAGS = Object.freeze(['bug', 'idea', 'confusing', 'fun', 'unfair']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// The first `max` code points: [...s] splits by code point, as Godot's String.length() counts.
function cutCodePoints(s, max) {
  const points = [...s];
  return points.length <= max ? s : points.slice(0, max).join('');
}

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  const given = new Set(v.filter((t) => typeof t === 'string').map((t) => t.trim().toLowerCase()));
  return TAGS.filter((t) => given.has(t));
}

function jsonBytes(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

// Over the cap: {"truncated": true} plus each top-level key, in the order sent, that still fits.
function capContext(v) {
  if (!isObject(v)) return {};
  if (jsonBytes(v) <= CONTEXT_MAX_BYTES) return v;
  const out = { truncated: true };
  for (const [k, child] of Object.entries(v)) {
    if (k === 'truncated') continue;
    out[k] = child;
    if (jsonBytes(out) > CONTEXT_MAX_BYTES) delete out[k];
  }
  return out;
}

// body -> { id, message, tags, written_at, context }, or throws VALIDATION.
function cleanEntry(body) {
  const b = isObject(body) ? body : {};
  if (!isUuid(b.id)) fail('VALIDATION', { message: "That feedback couldn't be read." });
  if (typeof b.message !== 'string' || b.message.trim() === '') {
    fail('VALIDATION', { message: 'Write something before sending.' });
  }
  return {
    id: b.id.toLowerCase(),
    message: cutCodePoints(b.message.trim(), MESSAGE_MAX),
    tags: cleanTags(b.tags),
    written_at: typeof b.written_at === 'string' ? cutCodePoints(b.written_at, WRITTEN_AT_MAX) : null,
    context: capContext(b.context),
  };
}

module.exports = {
  cleanEntry, capContext, cleanTags, cutCodePoints, isUuid,
  MESSAGE_MAX, WRITTEN_AT_MAX, CONTEXT_MAX_BYTES, TAGS,
};
