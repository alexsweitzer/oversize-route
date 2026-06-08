const express = require('express');
const { query, getOne } = require('../db/pool');
const { requireAuth }   = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/drivers ─────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT d.*,
        COUNT(r.id) FILTER (WHERE r.status IN ('sent','active')) AS active_routes
      FROM drivers d
      LEFT JOIN routes r ON r.driver_id = d.id
      WHERE d.company_id = $1 OR d.company_id IS NULL
      GROUP BY d.id
      ORDER BY d.full_name ASC
    `, [req.user.id]);
    res.json({ drivers: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

// ─── POST /api/drivers ────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { full_name, phone, email, unit_number } = req.body;
    if (!full_name) return res.status(400).json({ error: 'Driver name required' });

    const driver = await getOne(`
      INSERT INTO drivers (full_name, phone, email, unit_number, company_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [full_name, phone || null, email || null, unit_number || null, req.user.id]);

    res.status(201).json({ driver });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create driver' });
  }
});

// ─── PUT /api/drivers/:id ─────────────────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { full_name, phone, email, unit_number, active } = req.body;
    const driver = await getOne(`
      UPDATE drivers SET full_name=$1, phone=$2, email=$3, unit_number=$4, active=$5
      WHERE id=$6
      RETURNING *
    `, [full_name, phone || null, email || null, unit_number || null, active !== false, req.params.id]);

    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    res.json({ driver });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

// ─── DELETE /api/drivers/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query('UPDATE drivers SET active=false WHERE id=$1', [req.params.id]);
    res.json({ deactivated: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate driver' });
  }
});

module.exports = router;
