// database.js
// PostgreSQL connection + schema setup for hostel-fix

const { Pool } = require('pg');
require('dotenv').config();

// Render provides DATABASE_URL in production.
// Locally, .env file provides it.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Locally: create backend/.env with DATABASE_URL=...');
  console.error('On Render: set it in Environment settings.');
  process.exit(1);
}

// Render's external Postgres requires SSL.
// We disable strict cert validation because Render uses valid certs but
// pg's default rejects them unless we configure. Simple approach:
const useSSL = connectionString.includes('render.com') ||
               connectionString.includes('sslmode=require');

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

// Create table on startup
async function initSchema() {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      student_name TEXT NOT NULL,
      student_roll TEXT NOT NULL,
      room_number TEXT NOT NULL,
      hostel TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      assigned_to TEXT,
      priority TEXT NOT NULL DEFAULT 'NORMAL',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      feedback TEXT
    )
  `;

  try {
    await pool.query(createTableSQL);
    console.log('Database schema ready (PostgreSQL)');
  } catch (err) {
    console.error('Error creating schema:', err.message);
    throw err;
  }
}

module.exports = { pool, initSchema };