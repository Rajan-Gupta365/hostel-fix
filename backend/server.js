// server.js
// Main backend server for hostel-fix

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend files (index.html, student.html, warden.html) from ../frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Helper: current timestamp as string
function now() {
  return new Date().toISOString();
}

// ---------------------------------------------
// ROUTE 1: Student submits a new complaint
// POST /api/complaints
// ---------------------------------------------
app.post('/api/complaints', (req, res) => {
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

    const timestamp = now();

    // Check for duplicate: same room + same subcategory + active status, within 24 hours
    const duplicate = db.prepare(`
      SELECT id FROM complaints
      WHERE room_number = ?
        AND subcategory = ?
        AND status NOT IN ('CLOSED', 'REJECTED')
        AND datetime(created_at) > datetime('now', '-1 day')
    `).get(room_number, subcategory);

    if (duplicate) {
      return res.status(200).json({
        message: 'Duplicate complaint already exists',
        complaint_id: duplicate.id,
        duplicate: true
      });
    }

    const stmt = db.prepare(`
      INSERT INTO complaints (
        student_name, student_roll, room_number, hostel,
        category, subcategory, description, status, priority,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
    `);

    const result = stmt.run(
      student_name,
      student_roll,
      room_number,
      hostel,
      category,
      subcategory,
      description || '',
      priority || 'NORMAL',
      timestamp,
      timestamp
    );

    res.status(201).json({
      message: 'Complaint submitted successfully',
      complaint_id: result.lastInsertRowid,
      duplicate: false
    });
  } catch (err) {
    console.error('Error submitting complaint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ROUTE 2: Warden fetches all complaints
// GET /api/complaints
// Supports optional query: ?hostel=Hostel B&status=PENDING
// ---------------------------------------------
app.get('/api/complaints', (req, res) => {
  try {
    const { hostel, status } = req.query;
    let sql = 'SELECT * FROM complaints WHERE 1=1';
    const params = [];

    if (hostel) {
      sql += ' AND hostel = ?';
      params.push(hostel);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += `
      ORDER BY
        CASE priority WHEN 'EMERGENCY' THEN 0 ELSE 1 END,
        datetime(created_at) DESC
    `;

    const complaints = db.prepare(sql).all(...params);
    res.json(complaints);
  } catch (err) {
    console.error('Error fetching complaints:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ROUTE 3: Fetch complaints by roll number
// GET /api/complaints/by-roll/:roll
// ---------------------------------------------
app.get('/api/complaints/by-roll/:roll', (req, res) => {
  try {
    const roll = req.params.roll;
    const complaints = db.prepare(`
      SELECT * FROM complaints
      WHERE student_roll = ?
      ORDER BY datetime(created_at) DESC
    `).all(roll);

    res.json(complaints);
  } catch (err) {
    console.error('Error fetching by roll:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ROUTE 4: Fetch one complaint by ID
// GET /api/complaints/:id
// ---------------------------------------------
app.get('/api/complaints/:id', (req, res) => {
  try {
    const id = req.params.id;

    // Prevent this route from catching 'by-roll' (safety)
    if (isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid complaint ID' });
    }

    const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }
    res.json(complaint);
  } catch (err) {
    console.error('Error fetching complaint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------
// ROUTE 5: Warden updates complaint status
// PATCH /api/complaints/:id
// ---------------------------------------------
app.patch('/api/complaints/:id', (req, res) => {
  try {
    const id = req.params.id;
    const { status, assigned_to, feedback } = req.body;

    const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    const timestamp = now();

    const updates = [];
    const values = [];

    if (status) {
      updates.push('status = ?');
      values.push(status);
    }
    if (assigned_to !== undefined) {
      updates.push('assigned_to = ?');
      values.push(assigned_to);
    }
    if (feedback !== undefined) {
      updates.push('feedback = ?');
      values.push(feedback);
    }

    updates.push('updated_at = ?');
    values.push(timestamp);

    if (status === 'RESOLVED') {
      updates.push('resolved_at = ?');
      values.push(timestamp);
    }
    if (status === 'CLOSED') {
      updates.push('closed_at = ?');
      values.push(timestamp);
    }
    if (status === 'REOPENED') {
      updates.push('reopen_count = reopen_count + 1');
    }

    values.push(id);

    db.prepare(`
      UPDATE complaints SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    const updated = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
    res.json(updated);
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
  res.json({ status: 'ok', time: now() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Hostel-Fix backend running at http://localhost:${PORT}`);
  console.log(`Home page:     http://localhost:${PORT}/`);
  console.log(`Student page:  http://localhost:${PORT}/student.html`);
  console.log(`Warden page:   http://localhost:${PORT}/warden.html`);
});