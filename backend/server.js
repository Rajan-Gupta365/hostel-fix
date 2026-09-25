// server.js
// Main backend server for hostel-fix (PostgreSQL + Auth + Admin + Student OTP + Complaint Codes)

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Resend } = require('resend');
require('dotenv').config();

const { pool, initSchema } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || '';

app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 30 * 24 * 60 * 60 * 1000
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

function requireStudent() {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.session.user.role !== 'student') {
      return res.status(403).json({ error: 'Student only' });
    }
    next();
  };
}

function requireStaff() {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.session.user.role !== 'warden' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Staff only' });
    }
    next();
  };
}

// ---------------------------------------------
// Helpers
// ---------------------------------------------
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isValidCollegeEmail(email) {
  if (!email || typeof email !== 'string') return false;
  email = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return false;
  if (ALLOWED_EMAIL_DOMAIN) {
    const domain = email.split('@')[1];
    return domain === ALLOWED_EMAIL_DOMAIN.toLowerCase();
  }
  return true;
}

// Generate next complaint code: HF-0047
async function generateComplaintCode() {
  const result = await pool.query(
    'SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM complaints'
  );
  const nextId = result.rows[0].next_id;
  const padded = String(nextId).padStart(4, '0');
  return 'HF-' + padded;
}

// Backfill old complaints that don't have a code yet
async function backfillComplaintCodes() {
  const result = await pool.query(
    `SELECT id FROM complaints WHERE complaint_code IS NULL ORDER BY id ASC`
  );
  for (const row of result.rows) {
    const padded = String(row.id).padStart(4, '0');
    const code = 'HF-' + padded;
    await pool.query(
      'UPDATE complaints SET complaint_code = $1 WHERE id = $2',
      [code, row.id]
    );
  }
  if (result.rows.length > 0) {
    console.log(`Backfilled ${result.rows.length} complaint codes.`);
  }
}

// =============================================
// STUDENT OTP + REGISTRATION ROUTES
// =============================================

app.post('/api/student/request-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();

    if (!isValidCollegeEmail(email)) {
      return res.status(400).json({
        error: ALLOWED_EMAIL_DOMAIN
          ? `Only ${ALLOWED_EMAIL_DOMAIN} emails are allowed.`
          : 'Please enter a valid email address.'
      });
    }

    const existing = await pool.query(
      'SELECT id FROM students WHERE email = $1',
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: 'This email is already registered. Please log in.'
      });
    }

    await pool.query(
      `UPDATE otp_codes SET used = TRUE
       WHERE email = $1 AND purpose = 'signup' AND used = FALSE`,
      [email]
    );

    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO otp_codes (email, code, purpose, expires_at)
       VALUES ($1, $2, 'signup', $3)`,
      [email, code, expiresAt]
    );

    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: email,
        subject: 'Your Hostel Fix verification code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
            <h2 style="color:#0d3b66;">Hostel Fix</h2>
            <p>Your verification code is:</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px;
                        padding: 16px; background: #f4f6f8; border-radius: 8px;
                        text-align: center; color: #0d3b66;">
              ${code}
            </div>
            <p style="color:#666; margin-top: 20px;">
              This code expires in 10 minutes.
            </p>
          </div>
        `
      });
    } catch (emailErr) {
      console.error('Email send error:', emailErr);
      return res.status(500).json({ error: 'Could not send email. Please try again.' });
    }

    res.json({ message: 'OTP sent to your email.' });
  } catch (err) {
    console.error('Request OTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/student/register', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();
    const password = req.body.password || '';
    const full_name = (req.body.full_name || '').trim();
    const roll_number = (req.body.roll_number || '').trim();
    const hostel = (req.body.hostel || '').trim();
    const room_number = (req.body.room_number || '').trim();

    if (!email || !code || !password || !full_name || !roll_number ||
        !hostel || !room_number) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await pool.query(
      'SELECT id FROM students WHERE email = $1',
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This email is already registered.' });
    }

    const otpResult = await pool.query(
      `SELECT * FROM otp_codes
       WHERE email = $1 AND purpose = 'signup' AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid OTP found. Please request a new one.' });
    }

    const otp = otpResult.rows[0];
    if (otp.code !== code) {
      return res.status(400).json({ error: 'Invalid code. Please check and try again.' });
    }
    if (new Date(otp.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    const hash = await bcrypt.hash(password, 10);

    const insertResult = await pool.query(
      `INSERT INTO students (email, password_hash, full_name, roll_number, hostel, room_number, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, email, full_name, roll_number, hostel, room_number`,
      [email, hash, full_name, roll_number, hostel, room_number]
    );

    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otp.id]);

    const student = insertResult.rows[0];

    req.session.user = {
      id: student.id,
      email: student.email,
      full_name: student.full_name,
      roll_number: student.roll_number,
      hostel: student.hostel,
      room_number: student.room_number,
      role: 'student'
    };

    res.status(201).json({
      message: 'Registration successful',
      user: req.session.user
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/student/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT * FROM students WHERE email = $1',
      [email]
    );
    const student = result.rows[0];
    if (!student) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, student.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.user = {
      id: student.id,
      email: student.email,
      full_name: student.full_name,
      roll_number: student.roll_number,
      hostel: student.hostel,
      room_number: student.room_number,
      role: 'student'
    };

    res.json({ message: 'Logged in', user: req.session.user });
  } catch (err) {
    console.error('Student login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/student/me', requireStudent(), (req, res) => {
  res.json({ user: req.session.user });
});

app.get('/api/student/my-complaints', requireStudent(), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM complaints WHERE student_roll = $1 ORDER BY created_at DESC`,
      [req.session.user.roll_number]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('My complaints error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// =============================================
// AUTH ROUTES (wardens + admins)
// =============================================

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
    let table;
    if (user.role === 'admin') table = 'admins';
    else if (user.role === 'warden') table = 'wardens';
    else if (user.role === 'student') table = 'students';
    else return res.status(400).json({ error: 'Unknown role' });

    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [user.id]);
    const record = result.rows[0];
    if (!record) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(current_password, record.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2`, [newHash, user.id]);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// =============================================
// ADMIN ROUTES
// =============================================

app.get('/api/admin/wardens', requireAdmin(), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, hostel, is_active, created_at
       FROM wardens ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List wardens error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

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

app.patch('/api/admin/wardens/:id/deactivate', requireAdmin(), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE wardens SET is_active = FALSE WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Warden not found' });
    res.json({ message: 'Warden deactivated' });
  } catch (err) {
    console.error('Deactivate warden error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/wardens/:id/reactivate', requireAdmin(), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE wardens SET is_active = TRUE WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Warden not found' });
    res.json({ message: 'Warden reactivated' });
  } catch (err) {
    console.error('Reactivate warden error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/wardens/:id/reset-password', requireAdmin(), async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    const result = await pool.query(
      `UPDATE wardens SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [hash, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Warden not found' });
    res.json({ message: 'Password reset' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// =============================================
// COMPLAINT ROUTES
// =============================================

app.post('/api/complaints', requireStudent(), async (req, res) => {
  try {
    const {
      student_name, student_roll, room_number, hostel,
      category, subcategory, description, priority
    } = req.body;

    if (!student_name || !student_roll || !room_number || !hostel ||
        !category || !subcategory) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Optional: enforce that the complaint is for the logged-in student
    if (req.session.user.role === 'student' &&
        req.session.user.roll_number !== student_roll) {
      return res.status(403).json({ error: 'You can only submit complaints for yourself' });
    }

    const dupResult = await pool.query(
      `SELECT id, complaint_code FROM complaints
       WHERE room_number = $1 AND subcategory = $2
         AND status NOT IN ('CLOSED', 'REJECTED')
         AND created_at > NOW() - INTERVAL '1 day'`,
      [room_number, subcategory]
    );

    if (dupResult.rows.length > 0) {
      return res.status(200).json({
        message: 'Duplicate complaint already exists',
        complaint_id: dupResult.rows[0].id,
        complaint_code: dupResult.rows[0].complaint_code,
        duplicate: true
      });
    }

    const complaint_code = await generateComplaintCode();

    const insertResult = await pool.query(
      `INSERT INTO complaints (
        complaint_code, student_name, student_roll, room_number, hostel,
        category, subcategory, description, status, priority
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
      RETURNING id, complaint_code`,
      [complaint_code, student_name, student_roll, room_number, hostel,
       category, subcategory, description || '', priority || 'NORMAL']
    );

    res.status(201).json({
      message: 'Complaint submitted successfully',
      complaint_id: insertResult.rows[0].id,
      complaint_code: insertResult.rows[0].complaint_code,
      duplicate: false
    });
  } catch (err) {
    console.error('Error submitting complaint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/complaints', requireStaff(), async (req, res) => {
  try {
    const { hostel, status } = req.query;
    const conditions = [];
    const params = [];

    if (req.session.user.role === 'warden') {
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
      `SELECT * FROM complaints ${whereClause}
       ORDER BY CASE priority WHEN 'EMERGENCY' THEN 0 ELSE 1 END, created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching complaints:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/complaints/by-roll/:roll', requireStaff(), async (req, res) => {
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

app.get('/api/complaints/:id', requireStaff(), async (req, res) => {
  try {
    const id = req.params.id;
    if (isNaN(Number(id))) return res.status(400).json({ error: 'Invalid complaint ID' });

    const result = await pool.query('SELECT * FROM complaints WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Complaint not found' });
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
    if (check.rows.length === 0) return res.status(404).json({ error: 'Complaint not found' });

    const role = req.session.user.role;

    // Warden scoped to own hostel
    if (role === 'warden' && check.rows[0].hostel !== req.session.user.hostel) {
      return res.status(403).json({ error: 'Not authorized for this hostel' });
    }

    // Student can only confirm or reopen their own complaints
    if (role === 'student') {
      if (check.rows[0].student_roll !== req.session.user.roll_number) {
        return res.status(403).json({ error: 'Not your complaint' });
      }
      if (status !== 'CLOSED' && status !== 'REOPENED') {
        return res.status(403).json({ error: 'Students may only confirm or reopen' });
      }
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
    await backfillComplaintCodes();
    app.listen(PORT, () => {
      console.log(`Hostel-Fix backend running at http://localhost:${PORT}`);
      console.log(`Home:      http://localhost:${PORT}/`);
      console.log(`Student:   http://localhost:${PORT}/student.html`);
      console.log(`Signup:    http://localhost:${PORT}/signup.html`);
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