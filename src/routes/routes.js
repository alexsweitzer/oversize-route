const express = require('express');
const { query, getOne } = require('../db/pool');
const { requireAuth }   = require('../middleware/auth');
const { analyzePermitsWithAI } = require('../services/ai');

const router = express.Router();

// ─── GET /api/routes — list all routes for this dispatcher ────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        r.id, r.share_token, r.origin_address, r.dest_address,
        r.load_description, r.status, r.total_distance_mi,
        r.total_duration_min, r.states_crossed, r.current_step,
        r.created_at, r.updated_at,
        d.full_name AS driver_name, d.unit_number, d.phone AS driver_phone
      FROM routes r
      LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.created_by = $1
      ORDER BY r.updated_at DESC
      LIMIT 50
    `, [req.user.id]);
    res.json({ routes: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

// ─── POST /api/routes — create a new route ────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { origin_address, dest_address, load_description, load_width, driver_id, waypoints_raw } = req.body;
    if (!origin_address || !dest_address) {
      return res.status(400).json({ error: 'Origin and destination addresses required' });
    }

    const route = await getOne(`
      INSERT INTO routes (created_by, origin_address, dest_address, load_description, load_width, driver_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'draft')
      RETURNING *
    `, [req.user.id, origin_address, dest_address, load_description || null, load_width || null, driver_id || null]);

    // Log activity
    await logActivity(route.id, req.user.id, null, 'route_created', `Route created: ${origin_address} → ${dest_address}`);

    res.status(201).json({ route });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create route' });
  }
});

// ─── GET /api/routes/:id — get full route detail ──────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const route = await getOne(`
      SELECT r.*, d.full_name AS driver_name, d.unit_number, d.phone AS driver_phone
      FROM routes r
      LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.id = $1 AND r.created_by = $2
    `, [req.params.id, req.user.id]);

    if (!route) return res.status(404).json({ error: 'Route not found' });

    // Fetch associated permits
    const { rows: permits } = await query(
      'SELECT id, state_code, file_name, file_url, status, extracted_data FROM permits WHERE route_id = $1',
      [route.id]
    );

    // Fetch recent activity
    const { rows: activity } = await query(`
      SELECT a.action, a.detail, a.created_at,
             u.full_name AS dispatcher_name
      FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.route_id = $1
      ORDER BY a.created_at DESC
      LIMIT 20
    `, [route.id]);

    res.json({ route, permits, activity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch route' });
  }
});

// ─── PUT /api/routes/:id — update route details ───────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { origin_address, dest_address, load_description, load_width, driver_id } = req.body;
    const route = await getOne(`
      UPDATE routes
      SET origin_address=$1, dest_address=$2, load_description=$3,
          load_width=$4, driver_id=$5
      WHERE id=$6 AND created_by=$7
      RETURNING *
    `, [origin_address, dest_address, load_description, load_width, driver_id || null, req.params.id, req.user.id]);

    if (!route) return res.status(404).json({ error: 'Route not found' });
    res.json({ route });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update route' });
  }
});

// ─── POST /api/routes/:id/analyze — run AI permit analysis ───────────────────
router.post('/:id/analyze', requireAuth, async (req, res) => {
  try {
    const route = await getOne(
      'SELECT * FROM routes WHERE id = $1 AND created_by = $2',
      [req.params.id, req.user.id]
    );
    if (!route) return res.status(404).json({ error: 'Route not found' });

    const { rows: permits } = await query(
      'SELECT * FROM permits WHERE route_id = $1',
      [route.id]
    );

    // Update status
    await query('UPDATE routes SET status=$1 WHERE id=$2', ['draft', route.id]);

    // Run AI analysis
    const analysis = await analyzePermitsWithAI(route, permits);

    // Save results
    const updated = await getOne(`
      UPDATE routes SET
        steps                = $1,
        waypoints            = $2,
        total_distance_mi    = $3,
        total_duration_min   = $4,
        states_crossed       = $5,
        ai_analysis          = $6,
        permit_alerts        = $7,
        status               = 'ready'
      WHERE id = $8
      RETURNING *
    `, [
      JSON.stringify(analysis.steps),
      JSON.stringify(analysis.waypoints),
      analysis.distance_mi,
      analysis.duration_min,
      analysis.states,
      JSON.stringify(analysis),
      JSON.stringify(analysis.alerts),
      route.id,
    ]);

    await logActivity(route.id, req.user.id, null, 'route_analyzed',
      `AI analysis complete — ${analysis.steps.length} steps, ${analysis.distance_mi} mi`);

    res.json({ route: updated, analysis });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: 'AI analysis failed: ' + err.message });
  }
});

// ─── POST /api/routes/:id/send — mark as sent to driver ──────────────────────
router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const route = await getOne(`
      UPDATE routes SET status='sent' WHERE id=$1 AND created_by=$2 RETURNING *
    `, [req.params.id, req.user.id]);
    if (!route) return res.status(404).json({ error: 'Route not found' });

    await logActivity(route.id, req.user.id, route.driver_id, 'route_sent',
      `Route sent to driver — share link: /drive/${route.share_token}`);

    res.json({
      route,
      driver_link: `${process.env.APP_URL || ''}/drive/${route.share_token}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send route' });
  }
});

// ─── POST /api/routes/:id/ping — driver sends GPS location update ─────────────
router.post('/:id/ping', async (req, res) => {
  try {
    const { token, lat, lng, speed_mph, heading_deg, current_step } = req.body;

    // Verify share token
    const route = await getOne('SELECT id, driver_id FROM routes WHERE id=$1 AND share_token=$2', [req.params.id, token]);
    if (!route) return res.status(403).json({ error: 'Invalid route or token' });

    await query(`
      INSERT INTO location_pings (route_id, driver_id, lat, lng, speed_mph, heading_deg, current_step)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [route.id, route.driver_id, lat, lng, speed_mph || null, heading_deg || null, current_step || 0]);

    // Update current step on route
    if (current_step !== undefined) {
      await query('UPDATE routes SET current_step=$1 WHERE id=$2', [current_step, route.id]);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ping failed' });
  }
});

// ─── GET /api/routes/:id/live — dispatcher polls driver location ───────────────
router.get('/:id/live', requireAuth, async (req, res) => {
  try {
    const ping = await getOne(`
      SELECT lat, lng, speed_mph, heading_deg, current_step, pinged_at
      FROM location_pings
      WHERE route_id = $1
      ORDER BY pinged_at DESC
      LIMIT 1
    `, [req.params.id]);
    res.json({ ping: ping || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get live location' });
  }
});

// ─── DELETE /api/routes/:id ───────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM routes WHERE id=$1 AND created_by=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Route not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete route' });
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────
async function logActivity(routeId, userId, driverId, action, detail) {
  try {
    await query(`
      INSERT INTO activity_log (route_id, user_id, driver_id, action, detail)
      VALUES ($1, $2, $3, $4, $5)
    `, [routeId, userId || null, driverId || null, action, detail]);
  } catch (e) {
    console.warn('Activity log failed (non-fatal):', e.message);
  }
}

module.exports = router;
