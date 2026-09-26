// server.js
// Main backend server for hostel-fix (PostgreSQL + Auth + Admin + Student OTP + Brevo + Password Reset + Warden Invite)

const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();

const { pool, initSchema } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const EMAIL_SENDER_NAME = process.env.EMAIL_SENDER_NAME || 'Hostel Fix';
const EMAIL_SENDER_ADDRESS = process.env.EMAIL_USER || 'hostelfix.help@gmail.com';
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

if (!BREVO_API_KEY) {
  console.error('WARNING: BREVO_API_KEY not set. OTP emails will fail.');
}

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

function generateTempPassword() {
  // 3 random words + 2-digit number — readable & secure
  const words = [
    'purple', 'tiger', 'cloud', 'river', 'happy', 'moon', 'silver', 'ocean',
    'forest', 'ember', 'cedar', 'amber', 'golden', 'crimson', 'azure', 'quiet'
  ];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const w3 = words[Math.floor(Math.random() * words.length)];
  const num = String(Math.floor(10 + Math.random() * 90));
  return `${w1}-${w2}-${w3}-${num}`;
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  email = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidCollegeEmail(email) {
  if (!isValidEmail(email)) return false;
  if (ALLOWED_EMAIL_DOMAIN) {
    const domain = email.split('@')[1];
    return domain === ALLOWED_EMAIL_DOMAIN.toLowerCase();
  }
  return true;
}

async function findUserByEmail(email) {
  let result = await pool.query('SELECT * FROM students WHERE email = $1', [email]);
  if (result.rows.length > 0) {
    return { table: 'students', user: result.rows[0] };
  }
  result = await pool.query('SELECT * FROM wardens WHERE email = $1', [email]);
  if (result.rows.length > 0) {
    return { table: 'wardens', user: result.rows[0] };
  }
  return { table: null, user: null };
}

async function generateComplaintCode() {
  const result = await pool.query(
    'SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM complaints'
  );
  const nextId = result.rows[0].next_id;
  const padded = String(nextId).padStart(4, '0');
  return 'HF-' + padded;
}

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

// ---------------------------------------------
// Email sender (Brevo)
// ---------------------------------------------
async function sendEmail(toEmail, subject, htmlBody) {
  const payload = {
    sender: {
      name: EMAIL_SENDER_NAME,
      email: EMAIL_SENDER_ADDRESS
    },
    to: [{ email: toEmail }],
    subject: subject,
    htmlContent: htmlBody
  };

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Brevo API error (${response.status}): ${errorBody}`);
  }

  return await response.json();
}

async function sendOTPEmail(toEmail, code, purpose) {
  let subject = 'Your Hostel Fix verification code';
  let intro = 'Your verification code is:';
  let footer = 'If you did not request this, you can ignore this email.';

  if (purpose === 'password_reset') {
    subject = 'Reset your Hostel Fix password';
    intro = 'You requested to reset your password. Use this code:';
    footer = 'If you did not request a password reset, please ignore this email.';
  }

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
      <h2 style="color:#0d3b66;">Hostel Fix</h2>
      <p>${intro}</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px;
                  padding: 16px; background: #f4f6f8; border-radius: 8px;
                  text-align: center; color: #0d3b66;">
        ${code}
      </div>
      <p style="color:#666; margin-top: 20px;">This code expires in 10 minutes.</p>
      <p style="color:#999; font-size: 12px;">${footer}</p>
    </div>
  `;

  return sendEmail(toEmail, subject, htmlBody);
}

async function sendWardenInviteEmail(toEmail, wardenName, username, tempPassword, hostel) {
  const loginUrl = `${APP_URL}/login.html`;
  const subject = 'Welcome to Hostel Fix — Your Warden Account';

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto;">
      <h2 style="color:#0d3b66;">Hostel Fix</h2>
      <p>Hello <strong>${wardenName}</strong>,</p>
      <p>Your warden account has been created for <strong>${hostel}</strong>.</p>

      <div style="background:#f4f6f8; padding:16px; border-radius:8px; margin:16px 0;">
        <p style="margin:0 0 8px 0;"><strong>Username:</strong> ${username}</p>
        <p style="margin:0 0 8px 0;"><strong>Temporary Password:</strong> ${tempPassword}</p>
        <p style="margin:0;"><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
      </div>

      <p style="color:#b3261e;"><strong>Important:</strong> You will be asked to change your password on your first login.</p>

      <p style="margin-top:24px;">
        <a href="${loginUrl}" style="background:#0d3b66;color:#ffffff;padding:12px 24px;
           text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">
          Log In Now →
        </a>
      </p>

      <p style="color:#999; font-size: 12px; margin-top: 24px;">
        If you did not expect this email, please contact the hostel admin.
      </p>
    </div>
  `;

  return sendEmail(toEmail, subject, htmlBody);
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
      await sendOTPEmail(email, code, 'signup');
    } catch (emailErr) {
      console.error('Email send error:', emailErr.message || emailErr);
      return res.status(500).json({
        error: 'Could not send verification email. Please try again.'
      });
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
// PASSWORD RESET ROUTES (all users)
// =============================================

app.post('/api/auth/request-reset-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const found = await findUserByEmail(email);

    if (found.table && found.user) {
      await pool.query(
        `UPDATE otp_codes SET used = TRUE
         WHERE email = $1 AND purpose = 'password_reset' AND used = FALSE`,
        [email]
      );

      const code = generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.query(
        `INSERT INTO otp_codes (email, code, purpose, expires_at)
         VALUES ($1, $2, 'password_reset', $3)`,
        [email, code, expiresAt]
      );

      try {
        await sendOTPEmail(email, code, 'password_reset');
      } catch (emailErr) {
        console.error('Reset email send error:', emailErr.message || emailErr);
        return res.status(500).json({
          error: 'Could not send reset email. Please try again.'
        });
      }
    }

    res.json({ message: 'If this email is registered, a reset code has been sent.' });
  } catch (err) {
    console.error('Request reset OTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/verify-reset-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code required' });
    }

    const otpResult = await pool.query(
      `SELECT * FROM otp_codes
       WHERE email = $1 AND purpose = 'password_reset' AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid reset code found. Please request a new one.' });
    }
    const otp = otpResult.rows[0];

    if (otp.code !== code) {
      return res.status(400).json({ error: 'Invalid code. Please check and try again.' });
    }
    if (new Date(otp.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    res.json({ message: 'Code verified.' });
  } catch (err) {
    console.error('Verify reset OTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();
    const new_password = req.body.new_password || '';

    if (!email || !code || !new_password) {
      return res.status(400).json({ error: 'Email, code, and new password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const found = await findUserByEmail(email);
    if (!found.table || !found.user) {
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }

    const otpResult = await pool.query(
      `SELECT * FROM otp_codes
       WHERE email = $1 AND purpose = 'password_reset' AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }
    const otp = otpResult.rows[0];

    if (otp.code !== code) {
      return res.status(400).json({ error: 'Invalid code. Please check and try again.' });
    }
    if (new Date(otp.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE ${found.table} SET password_hash = $1 WHERE id = $2`,
      [hash, found.user.id]
    );

    // If it's a warden, clear must_change_password
    if (found.table === 'wardens') {
      await pool.query(
        'UPDATE wardens SET must_change_password = FALSE WHERE id = $1',
        [found.user.id]
      );
    }

    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [otp.id]);

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
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
      hostel: user.hostel || null,
      must_change_password: user.must_change_password || false
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

    // If warden, clear must_change_password
    if (user.role === 'warden') {
      await pool.query('UPDATE wardens SET must_change_password = FALSE WHERE id = $1', [user.id]);
      req.session.user.must_change_password = false;
    }

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
      `SELECT id, username, full_name, email, hostel, is_active, must_change_password, created_at
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
    const { username, full_name, email, hostel } = req.body;

    if (!username || !hostel) {
      return res.status(400).json({ error: 'Username and hostel are required' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    const existing = await pool.query(
      'SELECT id FROM wardens WHERE username = $1',
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Generate temporary password
    const tempPassword = generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, 10);

    const result = await pool.query(
      `INSERT INTO wardens (username, password_hash, full_name, email, hostel, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
       RETURNING id, username, full_name, email, hostel, is_active, must_change_password, created_at`,
      [username, hash, full_name || username, email || null, hostel]
    );

    const warden = result.rows[0];

    // Send invite email if email was provided
    let emailSent = false;
    let emailError = null;
    if (email) {
      try {
        await sendWardenInviteEmail(email, warden.full_name, username, tempPassword, hostel);
        emailSent = true;
      } catch (emailErr) {
        console.error('Warden invite email error:', emailErr.message || emailErr);
        emailError = 'Warden created, but invite email failed. Please share the temp password manually.';
      }
    }

    res.status(201).json({
      message: emailSent ? 'Warden created and invite email sent' : 'Warden created',
      warden: warden,
      temp_password: email ? undefined : tempPassword,
      email_sent: emailSent,
      warning: emailError
    });
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
      `UPDATE wardens SET password_hash = $1, must_change_password = TRUE WHERE id = $2 RETURNING id`,
      [hash, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Warden not found' });
    res.json({ message: 'Password reset. Warden must change it on next login.' });
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

    if (role === 'warden' && check.rows[0].hostel !== req.session.user.hostel) {
      return res.status(403).json({ error: 'Not authorized for this hostel' });
    }

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
      console.log(`Forgot:    http://localhost:${PORT}/forgot-password.html`);
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