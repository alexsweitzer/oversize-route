const express = require('express');
const path    = require('path');
const { query, getOne } = require('../db/pool');
const { requireAuth }   = require('../middleware/auth');
const { upload, useS3 } = require('../middleware/upload');

const router = express.Router();

// ─── POST /api/permits/upload/:routeId — upload a permit file ─────────────────
router.post('/upload/:routeId', requireAuth, upload.single('permit'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Confirm route belongs to this user
    const route = await getOne('SELECT id FROM routes WHERE id=$1 AND created_by=$2', [req.params.routeId, req.user.id]);
    if (!route) return res.status(404).json({ error: 'Route not found' });

    const fileUrl = useS3
      ? req.file.location              // S3 returns .location
      : `/uploads/${req.file.filename}`; // local path

    const stateCode = req.body.state_code || guessStateFromFilename(req.file.originalname);

    const permit = await getOne(`
      INSERT INTO permits (route_id, state_code, file_name, file_url, file_size_kb, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `, [route.id, stateCode, req.file.originalname, fileUrl, Math.round(req.file.size / 1024)]);

    res.status(201).json({ permit });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ─── GET /api/permits/:routeId — list permits for a route ─────────────────────
router.get('/:routeId', requireAuth, async (req, res) => {
  try {
    // Confirm route ownership
    const route = await getOne('SELECT id FROM routes WHERE id=$1 AND created_by=$2', [req.params.routeId, req.user.id]);
    if (!route) return res.status(404).json({ error: 'Route not found' });

    const { rows } = await query(`
      SELECT id, state_code, file_name, file_url, file_size_kb, status, extracted_data, uploaded_at
      FROM permits WHERE route_id=$1 ORDER BY uploaded_at ASC
    `, [route.id]);
    res.json({ permits: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch permits' });
  }
});

// ─── DELETE /api/permits/:id — remove a permit ───────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Join through route to confirm ownership
    const result = await query(`
      DELETE FROM permits p
      USING routes r
      WHERE p.id=$1 AND p.route_id=r.id AND r.created_by=$2
      RETURNING p.id
    `, [req.params.id, req.user.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Permit not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete permit' });
  }
});

// ─── Helper: guess state code from filename ───────────────────────────────────
function guessStateFromFilename(filename) {
  const f = filename.toUpperCase();
  const states = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
    'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  for (const s of states) {
    if (f.startsWith(s + '_') || f.startsWith(s + '-') || f.includes('_' + s + '_')) return s;
  }
  return 'UNKNOWN';
}

module.exports = router;
