// db.js

const log = require('./log');
const mysql = require('mysql2/promise');

let pool = null;

// mysqlConfig is config/env.js's MYSQL block.
function initDB(mysqlConfig) {
  pool = mysql.createPool({
    ...mysqlConfig,
    waitForConnections: true,
    connectionLimit: 10,       // <-- max connections in pool
    queueLimit: 0              // <-- unlimited queued requests
  });
  return pool;
}

async function connectDB() {
  try {
    const connection = await getDB().getConnection();
    log.info('Connected to MySQL (via pool)!');
    connection.release(); // release immediately after test
  } catch (err) {
    log.error('Error connecting to MySQL:', err);
    throw err;
  }
}

function getDB() {
  if (!pool) throw new Error('initDB() has not run');
  return pool;
}

module.exports = { initDB, connectDB, getDB };
