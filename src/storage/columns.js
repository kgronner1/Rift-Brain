// The column lists of user_stats and user_accolades, read from INFORMATION_SCHEMA and cached.
const { getDB } = require('../db');

let userStatsColumnsCache = null;

// In-memory set of valid accolade column names, seeded from user_accolades at startup.
// Refreshed on a short TTL so newly added accolade columns become valid without a restart.
let accoladeColumnsCache = null;
let accoladeColumnsCacheRefreshedAt = 0;
const ACCOLADE_COLUMNS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadAccoladeColumns() {
  const now = Date.now();
  if (accoladeColumnsCache && (now - accoladeColumnsCacheRefreshedAt) < ACCOLADE_COLUMNS_CACHE_TTL_MS) {
    return accoladeColumnsCache;
  }
  const db = getDB();
  const [rows] = await db.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_accolades'
       AND COLUMN_NAME NOT IN ('user_id', '_last_updated')
     ORDER BY ORDINAL_POSITION;`
  );
  accoladeColumnsCache = new Set(rows.map(r => r.COLUMN_NAME));
  accoladeColumnsCacheRefreshedAt = now;
  return accoladeColumnsCache;
}

async function isValidAccoladeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 64) return false;
  const set = await loadAccoladeColumns();
  return set.has(key);
}

async function loadUserStatsColumns() {
  if (userStatsColumnsCache) return userStatsColumnsCache;
  const db = getDB();
  const [rows] = await db.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_stats'
     ORDER BY ORDINAL_POSITION;`
  );
  const list = rows.map((row) => row.COLUMN_NAME);
  userStatsColumnsCache = { list, set: new Set(list) };
  return userStatsColumnsCache;
}

async function getUserStatsColumns() {
  const { list } = await loadUserStatsColumns();
  return list;
}

function formatUserStatsColumnName(column) {
  if (column === 'user_id') return 'User ID';

  let suffix = '';
  let base = column;
  if (base.startsWith('sp_')) {
    suffix = ' (Single Player)';
    base = base.slice(3);
  } else if (base.startsWith('mp_')) {
    suffix = ' (Multiplayer)';
    base = base.slice(3);
  }

  const replacements = {
    num: 'Number',
    sec: 'Seconds',
    alltime: 'All Time',
  };
  const lowerWords = new Set(['in', 'a', 'of', 'by', 'the', 'to', 'and', 'per']);

  const words = base.split('_').map((token) => {
    const lower = token.toLowerCase();
    if (replacements[lower]) return replacements[lower];
    if (lowerWords.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });

  let label = words.join(' ');
  if (label.startsWith('Number ')) {
    label = label.replace(/^Number /, 'Number of ');
  }

  return `${label}${suffix}`;
}

async function requireUserStatsField(field) {
  if (!field) throw new Error('Invalid user_stats field');
  const { set } = await loadUserStatsColumns();
  if (!set.has(field)) throw new Error('Invalid user_stats field');
  return field;
}

module.exports = {
  loadAccoladeColumns,
  isValidAccoladeKey,
  loadUserStatsColumns,
  getUserStatsColumns,
  formatUserStatsColumnName,
  requireUserStatsField,
};
