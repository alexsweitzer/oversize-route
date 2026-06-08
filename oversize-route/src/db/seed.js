require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

async function seed() {
  console.log('Seeding database…');
  const client = await pool.connect();
  try {

    // ─── Default admin dispatcher ─────────────────────────────────────────────
    const hash = await bcrypt.hash('ChangeMe123!', 12);
    await client.query(`
      INSERT INTO users (email, password_hash, full_name, role, company)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO NOTHING
    `, ['admin@oversizeroute.app', hash, 'Admin Dispatcher', 'admin', 'KMT']);
    console.log('  ✓ Default admin user created');
    console.log('    Email   : admin@oversizeroute.app');
    console.log('    Password: ChangeMe123!  ← CHANGE THIS IMMEDIATELY');

    // ─── Sample driver ────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO drivers (full_name, phone, unit_number)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, ['Jake Rivera', '+17135550192', 'TRK-044']);
    console.log('  ✓ Sample driver: Jake Rivera (TRK-044)');

    console.log('\n✓ Seed complete.');
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
