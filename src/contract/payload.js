'use strict';
// RJ 587: the payload ledger's entry rules, in one place. Wobble Planet's client holds the same numbers (its payload
// sender, Scripts/Net/); change them in both repos together. Pure: an accolade key's existence is checked by the
// caller (it is a user_accolades column).
//
//   source        ref                                       amount                         sent by
//   sp_run        run:<8-40 of [A-Za-z0-9_-]>               integer 1..5000                the client
//   accolade      accolade:<a user_accolades column>        one of 50, 100, 250, 500, 1000 the client, a game server
//   carry         carry                                     integer 0..100000 (the install's local balance)  the client
//   legacy_sync   legacy:<generated>                        written by the brain only (the single-player sync)

const MAX_ENTRIES = 32;
const REF_MAX = 64;

const SOURCES = Object.freeze(['sp_run', 'accolade', 'carry', 'legacy_sync']);
const FROM_CLIENT = Object.freeze(['sp_run', 'accolade', 'carry']);
const FROM_SERVER = Object.freeze(['accolade']);

const RUN_REF_RE = /^run:[A-Za-z0-9_-]{8,40}$/;
const RUN_MIN = 1;
const RUN_MAX = 5000;
const ACCOLADE_REF_PREFIX = 'accolade:';
const ACCOLADE_AMOUNTS = Object.freeze([50, 100, 250, 500, 1000]);
const CARRY_REF = 'carry';
const CARRY_MIN = 0;
const CARRY_MAX = 100000;
const LEGACY_REF_PREFIX = 'legacy:';

const STATUS = Object.freeze({ APPLIED: 'applied', DUPLICATE: 'duplicate', REJECTED: 'rejected', DEFERRED: 'deferred' });

// What a rejected (or deferred) entry's `reason` says.
const REASON = Object.freeze({
  BAD_SOURCE: 'bad source',
  NOT_ALLOWED: 'source not allowed here',
  BAD_REF: 'bad ref',
  BAD_AMOUNT: 'bad amount',
  UNKNOWN_ACCOLADE: 'unknown accolade key',
  NO_SUCH_USER: 'no such user',
  NOT_RECORDED: 'accolade not recorded yet',
});

function isIntIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// One entry's shape, for a caller that is 'client' or 'server'. Returns {ok: true, accoladeKey?} or {ok: false,
// reason}. Checked in order: the source, whether that caller may send it, the ref, the amount.
function checkEntry(entry, from) {
  const allowed = from === 'server' ? FROM_SERVER : FROM_CLIENT;
  const { source, ref, amount } = entry;
  if (typeof source !== 'string' || !SOURCES.includes(source)) return { ok: false, reason: REASON.BAD_SOURCE };
  if (!allowed.includes(source)) return { ok: false, reason: REASON.NOT_ALLOWED };
  if (typeof ref !== 'string' || ref.length > REF_MAX) return { ok: false, reason: REASON.BAD_REF };
  if (source === 'sp_run') {
    if (!RUN_REF_RE.test(ref)) return { ok: false, reason: REASON.BAD_REF };
    if (!isIntIn(amount, RUN_MIN, RUN_MAX)) return { ok: false, reason: REASON.BAD_AMOUNT };
    return { ok: true };
  }
  if (source === 'accolade') {
    const key = ref.startsWith(ACCOLADE_REF_PREFIX) ? ref.slice(ACCOLADE_REF_PREFIX.length) : '';
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) return { ok: false, reason: REASON.BAD_REF };
    if (!ACCOLADE_AMOUNTS.includes(amount)) return { ok: false, reason: REASON.BAD_AMOUNT };
    return { ok: true, accoladeKey: key };
  }
  // carry
  if (ref !== CARRY_REF) return { ok: false, reason: REASON.BAD_REF };
  if (!isIntIn(amount, CARRY_MIN, CARRY_MAX)) return { ok: false, reason: REASON.BAD_AMOUNT };
  return { ok: true };
}

// The whole call's shape: null when `entries` may be applied, else the VALIDATION message. Individually bad entries
// are not refused here (they come back `rejected`), but a non-object entry refuses the call.
function checkEntries(entries) {
  if (!Array.isArray(entries)) return 'Send {entries: [...]}.';
  if (entries.length > MAX_ENTRIES) return `Send at most ${MAX_ENTRIES} entries at a time.`;
  if (!entries.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e))) return 'Each entry is {ref, source, amount}.';
  return null;
}

module.exports = {
  MAX_ENTRIES,
  REF_MAX,
  SOURCES,
  FROM_CLIENT,
  FROM_SERVER,
  RUN_REF_RE,
  RUN_MIN,
  RUN_MAX,
  ACCOLADE_REF_PREFIX,
  ACCOLADE_AMOUNTS,
  CARRY_REF,
  CARRY_MIN,
  CARRY_MAX,
  LEGACY_REF_PREFIX,
  STATUS,
  REASON,
  checkEntry,
  checkEntries,
};
