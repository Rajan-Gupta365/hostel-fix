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

const useSSL = connectionString.includes('render.com') ||
               connectionString.includes('sslmode=require');

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

async function initSchema() {
  // Complaints table
  const complaintsSQL = `
    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      complaint_code TEXT UNIQUE,
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

  // Admins
  const adminsSQL = `
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Wardens
  const wardensSQL = `
    CREATE TABLE IF NOT EXISTS wardens (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      hostel TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Students
  const studentsSQL = `
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      roll_number TEXT NOT NULL,
      hostel TEXT NOT NULL,
      room_number TEXT NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // OTP codes
  const otpSQL = `
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'signup',
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  try {
    await pool.query(complaintsSQL);
    await pool.query(adminsSQL);
    await pool.query(wardensSQL);
    await pool.query(studentsSQL);
    await pool.query(otpSQL);

    // --- Migrations for existing tables ---

    // complaints.complaint_code
    await pool.query(`
      ALTER TABLE complaints
      ADD COLUMN IF NOT EXISTS complaint_code TEXT
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'complaints_complaint_code_key'
        ) THEN
          ALTER TABLE complaints
          ADD CONSTRAINT complaints_complaint_code_key UNIQUE (complaint_code);
        END IF;
      END $$;
    `);

    // wardens.email
    await pool.query(`
      ALTER TABLE wardens
      ADD COLUMN IF NOT EXISTS email TEXT
    `);

    // wardens.must_change_password
    await pool.query(`
      ALTER TABLE wardens
      ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE
    `);

    console.log('Database schema ready (complaints, admins, wardens, students, otp_codes)');
  } catch (err) {
    console.error('Error creating schema:', err.message);
    throw err;
  }
}

module.exports = { pool, initSchema };