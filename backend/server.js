// server.js
// Main backend server for hostel-fix (PostgreSQL version)

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { pool, initSchema } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Helper
function now() {
  return new Date();
}

// ---------------------------------------------
// ROUTE 1: Submit a new complaint
// POST /api/complaints
// ---------------------------------------------
app.post('/api/complaints', async (req, res) => {
  try {
    const {
      student_name,
      student_roll,
      room_number,
      hostel,
      category,
      subcategory,
      description,
      priority
    } = req.body;

    if (!student_name || !student_roll || !room_number || !hostel ||
        !category || !subcategory) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Duplicate check
    const dupResult = await pool.query(
      `SELECT id FROM complaints
       WHERE room_number = $1
         AND subcategory = $2
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
      [
        student_name,
        student_roll,
        room_number,
        hostel,
        category,
        subcategory,
        description || '',
        priority || 'NORMAL'
      ]
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

// ---------------------------------------------
// ROUTE 2: Get all complaints (with optional filters)
// GET /api/complaints?hostel=X&status=Y
// ---------------------------------------------
app.get('/api/complaints', async (req, res) => {
  try {
    const { hostel, status } = req.query;
    const conditions = [];
    const params = [];

    if (hostel) {
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
       ORDER BY
         CASE priority WHEN 'EMERGENCY' THEN 0 ELSE 1 END,
         created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching complaints:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ROUTE 3: Get complaints by roll number
// GET /api/complaints/by-roll/:roll
// ---------------------------------------------
app.get('/api/complaints/by-roll/:roll', async (req, res) => {
  try {
    const roll = req.params.roll;
    const result = await pool.query(
      `SELECT * FROM complaints
       WHERE student_roll = $1
       ORDER BY created_at DESC`,
      [roll]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching by roll:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ROUTE 4: Get one complaint by ID
// GET /api/complaints/:id
// ---------------------------------------------
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

// ---------------------------------------------
// ROUTE 5: Update complaint (status, assigned_to, feedback)
// PATCH /api/complaints/:id
// ---------------------------------------------
app.patch('/api/complaints/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { status, assigned_to, feedback } = req.body;

    // Check exists
    const check = await pool.query('SELECT * FROM complaints WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    const updates = [];
    const values = [];

    if (status) {
      values.push(status);
      updates.push(`status = $${values.length}`);
    }
    if (assigned_to !== undefined) {
      values.push(assigned_to);
      updates.push(`assigned_to = $${values.length}`);
    }
    if (feedback !== undefined) {
      values.push(feedback);
      updates.push(`feedback = $${values.length}`);
    }

    updates.push(`updated_at = NOW()`);

    if (status === 'RESOLVED') {
      updates.push(`resolved_at = NOW()`);
    }
    if (status === 'CLOSED') {
      updates.push(`closed_at = NOW()`);
    }
    if (status === 'REOPENED') {
      updates.push(`reopen_count = reopen_count + 1`);
    }

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

// ---------------------------------------------
// ROUTE 6: Health check
// GET /api/health
// ---------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: now().toISOString() });
});

// ---------------------------------------------
// Start server (after DB schema is ready)
// ---------------------------------------------
async function start() {
  try {
    await initSchema();
    app.listen(PORT, () => {
      console.log(`Hostel-Fix backend running at http://localhost:${PORT}`);
      console.log(`Home page:     http://localhost:${PORT}/`);
      console.log(`Student page:  http://localhost:${PORT}/student.html`);
      console.log(`Warden page:   http://localhost:${PORT}/warden.html`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();