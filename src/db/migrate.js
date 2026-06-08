require('dotenv').config();
const { pool } = require('./pool');

const migrations = [

// ─── 001: Users (dispatchers / admins) ───────────────────────────────────────
`CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'dispatcher' CHECK (role IN ('admin','dispatcher')),
  company      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
)`,

// ─── 002: Drivers ─────────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS drivers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  unit_number  TEXT,
  company_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  active       BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
)`,

// ─── 003: Routes ──────────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS routes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token     TEXT UNIQUE NOT NULL DEFAULT substr(md5(random()::text), 1, 12),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  driver_id       UUID REFERENCES drivers(id) ON DELETE SET NULL,

  -- Addresses
  origin_address  TEXT NOT NULL,
  dest_address    TEXT NOT NULL,
  load_description TEXT,
  load_width      TEXT,

  -- Route data (stored as JSON from Google Directions or AI extraction)
  steps           JSONB,         -- array of turn-by-turn steps
  waypoints       JSONB,         -- array of {lat,lng} points
  overview_polyline TEXT,        -- encoded polyline for map display
  total_distance_mi NUMERIC(8,2),
  total_duration_min INTEGER,
  states_crossed  TEXT[],

  -- Status
  status          TEXT DEFAULT 'draft' CHECK (status IN ('draft','ready','sent','active','completed')),
  driver_started_at TIMESTAMPTZ,
  driver_completed_at TIMESTAMPTZ,
  current_step    INTEGER DEFAULT 0,

  -- AI analysis result
  ai_analysis     JSONB,
  permit_alerts   JSONB,         -- array of {state, message}

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
)`,

// ─── 004: Permits ─────────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS permits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id     UUID REFERENCES routes(id) ON DELETE CASCADE,
  state_code   TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  file_url     TEXT,            -- S3/R2 URL or local path
  file_size_kb INTEGER,
  extracted_data JSONB,         -- AI-extracted route restrictions
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','analyzing','ready','error')),
  uploaded_at  TIMESTAMPTZ DEFAULT NOW()
)`,

// ─── 005: Driver location pings (live GPS tracking) ───────────────────────────
`CREATE TABLE IF NOT EXISTS location_pings (
  id           BIGSERIAL PRIMARY KEY,
  route_id     UUID REFERENCES routes(id) ON DELETE CASCADE,
  driver_id    UUID REFERENCES drivers(id) ON DELETE SET NULL,
  lat          NUMERIC(10,7) NOT NULL,
  lng          NUMERIC(10,7) NOT NULL,
  speed_mph    NUMERIC(5,1),
  heading_deg  NUMERIC(5,1),
  current_step INTEGER,
  pinged_at    TIMESTAMPTZ DEFAULT NOW()
)`,

// ─── 006: Activity log ────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS activity_log (
  id           BIGSERIAL PRIMARY KEY,
  route_id     UUID REFERENCES routes(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  driver_id    UUID REFERENCES drivers(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  detail       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
)`,

// ─── Indexes ──────────────────────────────────────────────────────────────────
`CREATE INDEX IF NOT EXISTS idx_routes_share_token   ON routes(share_token)`,
`CREATE INDEX IF NOT EXISTS idx_routes_driver_id     ON routes(driver_id)`,
`CREATE INDEX IF NOT EXISTS idx_routes_created_by    ON routes(created_by)`,
`CREATE INDEX IF NOT EXISTS idx_permits_route_id     ON permits(route_id)`,
`CREATE INDEX IF NOT EXISTS idx_pings_route_id       ON location_pings(route_id)`,
`CREATE INDEX IF NOT EXISTS idx_pings_pinged_at      ON location_pings(pinged_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_activity_route_id    ON activity_log(route_id)`,

// ─── Auto-update updated_at ───────────────────────────────────────────────────
`CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql`,

`DROP TRIGGER IF EXISTS routes_updated_at ON routes`,
`CREATE TRIGGER routes_updated_at
  BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at()`,
];

async function migrate() {
  console.log('Running database migrations…');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      await client.query(sql);
      const preview = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
      console.log(`  ✓ ${preview}…`);
    }
    console.log('\n✓ All migrations complete.');
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
