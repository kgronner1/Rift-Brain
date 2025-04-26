// db.js

const { MongoClient } = require('mongodb');

const uri = 'mongodb://localhost:27017'; // <-- your Mongo URL
const client = new MongoClient(uri);

let db;

async function connectDB() {
  await client.connect();
  db = client.db('riftbrain'); // <-- your database name
  console.log('Connected to MongoDB!');
}

function getDB() {
  if (!db) {
    throw new Error('Database not connected. Call connectDB first.');
  }
  return db;
}

module.exports = { connectDB, getDB };
