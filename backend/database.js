// database.js
// PostgreSQL connection + schema setup for hostel-fix

const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Locally: create backend/.env with DATABASE_URL=...');
  console.error('On Render: set it in Environment settings.');
  process.exit(1);
}

// Render's external Postgres requires SSL.
const useSSL = connectionString.includes('render.com') ||
               connectionString.includes('sslmode=require');

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

async function initSchema() {
  // Complaints table (unchanged)
  const complaintsSQL = `
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

  // Admins (Super Admin accounts)
  const adminsSQL = `
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Wardens (hostel staff accounts, created by Super Admin)
  const wardensSQL = `
    CREATE TABLE IF NOT EXISTS wardens (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      hostel TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  try {
    await pool.query(complaintsSQL);
    await pool.query(adminsSQL);
    await pool.query(wardensSQL);
    console.log('Database schema ready (complaints, admins, wardens)');
  } catch (err) {
    console.error('Error creating schema:', err.message);
    throw err;
  }
}

module.exports = { pool, initSchema };