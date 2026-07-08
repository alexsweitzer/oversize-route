require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const { testConnection } = require('./db/pool');
const authRoutes          = require('./routes/auth');
const routesRoutes        = require('./routes/routes');
const permitsRoutes       = require('./routes/permits');
const driversRoutes       = require('./routes/drivers');
const driverViewRoutes    = require('./routes/driverView');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security & Logging ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP off — we serve inline scripts
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.APP_URL
    : '*',
  credentials: true,
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  message: { error: 'Too many requests, slow down.' },
});
app.use('/api/', limiter);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/routes',  routesRoutes);
app.use('/api/permits', permitsRoutes);
app.use('/api/drivers', driversRoutes);

// ─── Driver view (public — no auth needed, just a share token) ────────────────
app.use('/drive', driverViewRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ─── Public config (injects server-side env vars the frontend needs) ──────────
app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken:   process.env.MAPBOX_TOKEN || '',
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
    hereApiKey:    process.env.HERE_API_KEY || '',
    appUrl:        process.env.APP_URL || '',
  });
});

// ─── Catch-all → serve office portal SPA ─────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await testConnection();
    console.log('✓ Database connected');
    app.listen(PORT, () => {
      console.log(`✓ OverSize Route server running on port ${PORT}`);
      console.log(`  Environment : ${process.env.NODE_ENV || 'development'}`);
      console.log(`  Health check: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('✗ Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
