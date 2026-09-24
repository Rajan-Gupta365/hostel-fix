// server.js
// Main backend server for hostel-fix (PostgreSQL + Auth + Admin)

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();

const { pool, initSchema } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------
// Auth middleware
// ---------------------------------------------
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized for this role' });
    }
    next();
  };
}

function requireAdmin() {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  };
}

// ---------------------------------------------
// AUTH ROUTES
// ---------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    let result = await pool.query(
      'SELECT * FROM admins WHERE username = $1',
      [username]
    );
    let user = result.rows[0];
    let role = 'admin';

    if (!user) {
      result = await pool.query(
        'SELECT * FROM wardens WHERE username = $1 AND is_active = TRUE',
        [username]
      );
      user = result.rows[0];
      role = 'warden';
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: role,
      hostel: user.hostel || null
    };

    res.json({ message: 'Logged in', user: req.session.user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out' });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// ---------------------------------------------
// CHANGE PASSWORD (any logged-in user)
// POST /api/auth/change-password
// body: { current_password, new_password }
// ---------------------------------------------
app.post('/api/auth/change-password', requireAuth(), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = req.session.user;
    const table = user.role === 'admin' ? 'admins' : 'wardens';

    const result = await pool.query(
      `SELECT * FROM ${table} WHERE id = $1`,
      [user.id]
    );
    const record = result.rows[0];
    if (!record) {
      return res.status(404).json({ error: 'User not found' });
    }

    const match = await bcrypt.compare(current_password, record.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE ${table} SET password_hash = $1 WHERE id = $2`,
      [newHash, user.id]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ADMIN ROUTES (Super Admin only)
// ---------------------------------------------

// List all wardens
app.get('/api/admin/wardens', requireAdmin(), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, hostel, is_active, created_at
       FROM wardens
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List wardens error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a new warden
app.post('/api/admin/wardens', requireAdmin(), async (req, res) => {
  try {
    const { username, password, full_name, hostel } = req.body;

    if (!username || !password || !hostel) {
      return res.status(400).json({ error: 'Username, password, and hostel required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await pool.query(
      'SELECT id FROM wardens WHERE username = $1',
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO wardens (username, password_hash, full_name, hostel, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, username, full_name, hostel, is_active, created_at`,
      [username, hash, full_name || username, hostel]
    );

    res.status(201).json({ message: 'Warden created', warden: result.rows[0] });
  } catch (err) {
    console.error('Create warden error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deactivate a warden
app.patch('/api/admin/wardens/:id/deactivate', requireAdmin(), async (req, res) => {
  try {
    const id = req.params.id;
    const result = await pool.query(
      `UPDATE wardens SET is_active = FALSE WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warden not found' });
    }
    res.json({ message: 'Warden deactivated' });
  } catch (err) {
    console.error('Deactivate warden error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reactivate a warden
app.patch('/api/admin/wardens/:id/reactivate', requireAdmin(), async (req, res) => {
  try {
    const id = req.params.id;
    const result = await pool.query(
      `UPDATE wardens SET is_active = TRUE WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warden not found' });
    }
    res.json({ message: 'Warden reactivated' });
  } catch (err) {
    console.error('Reactivate warden error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset a warden's password
app.post('/api/admin/wardens/:id/reset-password', requireAdmin(), async (req, res) => {
  try {
    const id = req.params.id;
    const { new_password } = req.body;

    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    const result = await pool.query(
      `UPDATE wardens SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [hash, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Warden not found' });
    }
    res.json({ message: 'Password reset' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// COMPLAINT ROUTES
// ---------------------------------------------

app.post('/api/complaints', async (req, res) => {
  try {
    const {
      student_name, student_roll, room_number, hostel,
      category, subcategory, description, priority
    } = req.body;

    if (!student_name || !student_roll || !room_number || !hostel ||
        !category || !subcategory) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const dupResult = await pool.query(
      `SELECT id FROM complaints
       WHERE room_number = $1 AND subcategory = $2
         AND status NOT IN ('CLOSED', 'REJECTED')
         AND created_at > NOW() - INTERVAL '1 day'`,
      [room_number, subcategory]
    );

    if (dupResult.rows.length > 0) {
      return res.status(200).json({
        message: 'Duplicate complaint already exists',
        complaint_id: dupResult.rows[0].id,
        duplicate: true
      });
    }

    const insertResult = await pool.query(
      `INSERT INTO complaints (
        student_name, student_roll, room_number, hostel,
        category, subcategory, description, status, priority
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
      RETURNING id`,
      [student_name, student_roll, room_number, hostel,
       category, subcategory, description || '', priority || 'NORMAL']
    );

    res.status(201).json({
      message: 'Complaint submitted successfully',
      complaint_id: insertResult.rows[0].id,
      duplicate: false
    });
  } catch (err) {
    console.error('Error submitting complaint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/complaints', async (req, res) => {
  try {
    const { hostel, status } = req.query;
    const conditions = [];
    const params = [];

    if (req.session && req.session.user && req.session.user.role === 'warden') {
      params.push(req.session.user.hostel);
      conditions.push(`hostel = $${params.length}`);
    } else if (hostel) {
      params.push(hostel);
      conditions.push(`hostel = $${params.length}`);
    }

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT * FROM complaints
       ${whereClause}
       ORDER BY CASE priority WHEN 'EMERGENCY' THEN 0 ELSE 1 END, created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching complaints:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/complaints/by-roll/:roll', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM complaints WHERE student_roll = $1 ORDER BY created_at DESC`,
      [req.params.roll]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching by roll:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/complaints/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid complaint ID' });
    }
    const result = await pool.query('SELECT * FROM complaints WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching complaint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/complaints/:id', requireAuth(), async (req, res) => {
  try {
    const id = req.params.id;
    const { status, assigned_to, feedback } = req.body;

    const check = await pool.query('SELECT * FROM complaints WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    if (req.session.user.role === 'warden' &&
        check.rows[0].hostel !== req.session.user.hostel) {
      return res.status(403).json({ error: 'Not authorized for this hostel' });
    }

    const updates = [];
    const values = [];

    if (status) { values.push(status); updates.push(`status = $${values.length}`); }
    if (assigned_to !== undefined) { values.push(assigned_to); updates.push(`assigned_to = $${values.length}`); }
    if (feedback !== undefined) { values.push(feedback); updates.push(`feedback = $${values.length}`); }

    updates.push(`updated_at = NOW()`);
    if (status === 'RESOLVED') updates.push(`resolved_at = NOW()`);
    if (status === 'CLOSED') updates.push(`closed_at = NOW()`);
    if (status === 'REOPENED') updates.push(`reopen_count = reopen_count + 1`);

    values.push(id);
    const idPlaceholder = `$${values.length}`;

    await pool.query(
      `UPDATE complaints SET ${updates.join(', ')} WHERE id = ${idPlaceholder}`,
      values
    );

    const updated = await pool.query('SELECT * FROM complaints WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Error updating complaint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------------------------------------------
// Start
// ---------------------------------------------
async function start() {
  try {
    await initSchema();
    app.listen(PORT, () => {
      console.log(`Hostel-Fix backend running at http://localhost:${PORT}`);
      console.log(`Home:      http://localhost:${PORT}/`);
      console.log(`Student:   http://localhost:${PORT}/student.html`);
      console.log(`Warden:    http://localhost:${PORT}/warden.html`);
      console.log(`Login:     http://localhost:${PORT}/login.html`);
      console.log(`Admin:     http://localhost:${PORT}/admin.html`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();