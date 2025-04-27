// db.js

const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,     // <-- your database name
    waitForConnections: true,
    connectionLimit: 10,       // <-- max connections in pool
    queueLimit: 0              // <-- unlimited queued requests
});

async function connectDB() {
  try {
    const connection = await pool.getConnection();
    console.log('Connected to MySQL (via pool)!');
    connection.release(); // release immediately after test
  } catch (err) {
    console.error('Error connecting to MySQL:', err);
    throw err;
  }
}

function getDB() {
  return pool;
}

module.exports = { connectDB, getDB };
