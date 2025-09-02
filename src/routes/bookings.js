'use strict'

const express = require('express')
const router = express.Router()
const { requireFeature } = require('../middleware/subscription')

// Alle Endpunkte hier sind intern und brauchen das Feature
router.use(requireFeature('booking'))

// ---- Services ----
router.get('/services', async (req, res, next) => {
  try {
    const r = await req.db.query(
      `SELECT id, name, duration_min, price, color, active, created_at
         FROM services
        WHERE active = true
        ORDER BY name`
    )
    res.json(r.rows)
  } catch (e) {
    next(e)
  }
})

router.post('/services', async (req, res, next) => {
  const { name, duration_min, price = 0, color } = req.body || {}
  if (!name || !duration_min) {
    return res.status(400).json({ error: 'name and duration_min required' })
  }
  try {
    const r = await req.db.query(
      `INSERT INTO services (tenant_id, name, duration_min, price, color)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)
       RETURNING *`,
      [name, Number(duration_min), Number(price), color || null]
    )
    res.status(201).json(r.rows[0])
  } catch (e) {
    next(e)
  }
})

// ---- Staff ----
router.get('/staff', async (req, res, next) => {
  try {
    const r = await req.db.query(
      `SELECT id, name, role, color, active, created_at
         FROM staff
        WHERE active = true
        ORDER BY name`
    )
    res.json(r.rows)
  } catch (e) {
    next(e)
  }
})

router.post('/staff', async (req, res, next) => {
  const { name, role, color } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  try {
    const r = await req.db.query(
      `INSERT INTO staff (tenant_id, name, role, color)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3)
       RETURNING *`,
      [name, role || null, color || null]
    )
    res.status(201).json(r.rows[0])
  } catch (e) {
    next(e)
  }
})

// ---- Availability Rules ----
router.get('/availability', async (req, res, next) => {
  try {
    const r = await req.db.query(
      `SELECT id, staff_id, weekday, start_time, end_time, exceptions
         FROM availability_rules
        ORDER BY staff_id NULLS FIRST, weekday, start_time`
    )
    res.json(r.rows)
  } catch (e) {
    next(e)
  }
})

router.post('/availability', async (req, res, next) => {
  const { staff_id, weekday, start_time, end_time, exceptions = [] } = req.body || {}
  if (weekday == null || !start_time || !end_time) {
    return res.status(400).json({ error: 'weekday, start_time, end_time required' })
  }
  try {
    const r = await req.db.query(
      `INSERT INTO availability_rules (tenant_id, staff_id, weekday, start_time, end_time, exceptions)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)
       RETURNING *`,
      [staff_id || null, Number(weekday), start_time, end_time, exceptions]
    )
    res.status(201).json(r.rows[0])
  } catch (e) {
    next(e)
  }
})

// ---- Bookings (Admin) ----
router.get('/', async (req, res, next) => {
  let { from, to } = req.query || {}
  try {
    if (!from || !to) {
      // Fallback: heutiger Tag
      const today = new Date()
      const d = today.toISOString().slice(0, 10)
      from = new Date(`${d}T00:00:00Z`).toISOString()
      to = new Date(`${d}T23:59:59Z`).toISOString()
    }
    const r = await req.db.query(
      `SELECT b.*,
              s.name  AS service_name,
              st.name AS staff_name,
              c.name  AS customer_name
         FROM bookings b
         LEFT JOIN services s ON s.id = b.service_id
         LEFT JOIN staff st   ON st.id = b.staff_id
         LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.start_at >= $1 AND b.start_at < $2
        ORDER BY b.start_at`,
      [from, to]
    )
    res.json(r.rows)
  } catch (e) {
    next(e)
  }
})

router.post('/', async (req, res, next) => {
  const {
    service_id,
    customer_id,
    staff_id,
    start_at,
    end_at,
    notes,
    source = 'internal'
  } = req.body || {}
  if (!service_id || !start_at || !end_at) {
    return res.status(400).json({ error: 'service_id, start_at, end_at required' })
  }
  try {
    const r = await req.db.query(
      `INSERT INTO bookings (tenant_id, service_id, customer_id, staff_id, start_at, end_at, notes, source)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [service_id, customer_id || null, staff_id || null, start_at, end_at, notes || null, source]
    )
    res.status(201).json(r.rows[0])
  } catch (e) {
    next(e)
  }
})

router.patch('/:id', async (req, res, next) => {
  const { id } = req.params
  const { status, notes } = req.body || {}
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const r = await req.db.query(
      `UPDATE bookings
          SET status = COALESCE($2, status),
              notes  = COALESCE($3, notes)
        WHERE id = $1
        RETURNING *`,
      [id, status || null, notes || null]
    )
    if (!r.rowCount) return res.status(404).json({ error: 'not found' })
    res.json(r.rows[0])
  } catch (e) {
    next(e)
  }
})

module.exports = router
