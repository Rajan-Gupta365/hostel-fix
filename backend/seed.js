// seed.js
// One-time script: creates the first Super Admin account.
// Run once with: node seed.js
// Then you can create wardens from the admin panel later.

const bcrypt = require('bcrypt');
const { pool, initSchema } = require('./database');
require('dotenv').config();

// ==========================================
// CHANGE THESE BEFORE RUNNING (if you want)
// ==========================================
const ADMIN_USERNAME = 'superadmin';
const ADMIN_PASSWORD = 'admin12345';   // CHANGE THIS after first login
const ADMIN_FULLNAME = 'Super Admin';
// ==========================================

async function seed() {
  try {
    await initSchema();

    // Check if admin already exists
    const existing = await pool.query(
      'SELECT id FROM admins WHERE username = $1',
      [ADMIN_USERNAME]
    );

    if (existing.rows.length > 0) {
      console.log(`Admin "${ADMIN_USERNAME}" already exists. Skipping.`);
      process.exit(0);
    }

    // Hash the password (never store plain passwords!)
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

    await pool.query(
      'INSERT INTO admins (username, password_hash, full_name) VALUES ($1, $2, $3)',
      [ADMIN_USERNAME, hash, ADMIN_FULLNAME]
    );

    console.log('✅ Super Admin created successfully!');
    console.log('   Username: ' + ADMIN_USERNAME);
    console.log('   Password: ' + ADMIN_PASSWORD);
    console.log('');
    console.log('⚠️  IMPORTANT: Change this password after first login.');
    console.log('⚠️  Never share these credentials.');

    process.exit(0);
  } catch (err) {
    console.error('Error seeding admin:', err.message);
    process.exit(1);
  }
}

seed();