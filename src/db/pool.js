const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }  // Required for Railway's Postgres
    : false,
  max: 10,                 // Max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

async function testConnection() {
  const client = await pool.connect();
  await client.query('SELECT NOW()');
  client.release();
}

// Helper: run a query and return rows
async function query(text, params) {
  const start = Date.now();
  const res   = await pool.query(text, params);
  if (process.env.NODE_ENV === 'development') {
    console.log(`  DB [${Date.now() - start}ms] ${text.slice(0, 60)}`);
  }
  return res;
}

// Helper: get a single row (throws if not found)
async function getOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

module.exports = { pool, query, getOne, testConnection };
