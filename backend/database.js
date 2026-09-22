// database.js
// Sets up SQLite database and complaints table

const Database = require('better-sqlite3');
const path = require('path');

// Database file will be created at: backend/complaints.db
const dbPath = path.join(__dirname, 'complaints.db');
const db = new Database(dbPath);

// Enable foreign keys (good practice)
db.pragma('journal_mode = WAL');

// Create complaints table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    closed_at TEXT,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    feedback TEXT
  )
`);

console.log('Database ready at:', dbPath);

module.exports = db;