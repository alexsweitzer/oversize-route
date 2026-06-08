const express = require('express');
const path    = require('path');
const { getOne } = require('../db/pool');

const router = express.Router();

// ─── GET /drive/:token — serve the driver GPS view ───────────────────────────
// This is a public endpoint — no auth needed, just the share token
router.get('/:token', async (req, res) => {
  try {
    const route = await getOne(`
      SELECT
        r.id, r.share_token, r.origin_address, r.dest_address,
        r.steps, r.waypoints, r.overview_polyline,
        r.total_distance_mi, r.total_duration_min,
        r.states_crossed, r.permit_alerts, r.current_step, r.status,
        d.full_name AS driver_name, d.unit_number
      FROM routes r
      LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.share_token = $1 AND r.status IN ('ready','sent','active')
    `, [req.params.token]);

    if (!route) {
      return res.status(404).send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Route Not Found</title>
        <style>body{font-family:sans-serif;background:#080a08;color:#e8ede9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}h1{color:#f5a623}p{color:#6b7d6e}</style>
        </head><body><div><h1>Route Not Found</h1><p>This link may have expired or the route hasn't been sent yet.<br>Contact your dispatcher.</p></div></body></html>
      `);
    }

    // Mark route as active on first driver open
    if (route.status === 'sent') {
      await getOne('UPDATE routes SET status=$1, driver_started_at=NOW() WHERE share_token=$2 RETURNING id', ['active', req.params.token]);
    }

    // Inject route data into the driver GPS HTML page
    const routeData = JSON.stringify({
      id:           route.id,
      shareToken:   route.share_token,
      origin:       route.origin_address,
      destination:  route.dest_address,
      steps:        route.steps || [],
      waypoints:    route.waypoints || [],
      polyline:     route.overview_polyline || '',
      distanceMi:   route.total_distance_mi,
      durationMin:  route.total_duration_min,
      states:       route.states_crossed || [],
      alerts:       route.permit_alerts || [],
      currentStep:  route.current_step || 0,
      driverName:   route.driver_name || 'Driver',
      unitNumber:   route.unit_number || '',
    });

    // Send the driver GPS HTML with route pre-loaded
    res.sendFile(path.join(__dirname, '../../public/driver.html'), {}, (err) => {
      if (err) {
        // Fallback: inline the route data script
        res.send(buildDriverPage(routeData));
      }
    });
  } catch (err) {
    console.error('Driver view error:', err);
    res.status(500).send('Server error — contact your dispatcher');
  }
});

// ─── GET /drive/:token/data — driver app fetches route JSON ──────────────────
router.get('/:token/data', async (req, res) => {
  try {
    const route = await getOne(`
      SELECT r.id, r.steps, r.waypoints, r.overview_polyline,
             r.total_distance_mi, r.permit_alerts, r.current_step,
             r.origin_address, r.dest_address
      FROM routes r
      WHERE r.share_token = $1
    `, [req.params.token]);
    if (!route) return res.status(404).json({ error: 'Route not found' });
    res.json({ route });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load route data' });
  }
});

function buildDriverPage(routeDataJson) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OverSize Route — Navigation</title></head>
<body style="background:#080a08;color:#e8ede9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
<div>
  <h2 style="color:#f5a623">OverSize Route</h2>
  <p>Route loaded. Open the driver app to navigate.</p>
  <script>window.ROUTE_DATA = ${routeDataJson};</script>
</div></body></html>`;
}

module.exports = router;
