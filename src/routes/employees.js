'use strict'

const express = require('express')
const router = express.Router()

function isNonEmptyString (v) { return typeof v === 'string' && v.trim().length > 0 }
function isNumberLike (v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) }
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function isUUID (v) { return typeof v === 'string' && UUID_RX.test(v) }
function assertClient (req, res) { if (!req.db) { res.status(500).json({ error: 'Tenant context DB client missing' }); return false } return true }

// ---------- Employees base ----------

// LIST
router.get('/', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db

  /*
    #swagger.tags = ['Employees']
    #swagger.parameters['q']         = { in:'query', schema:{type:'string'} }
    #swagger.parameters['is_active'] = { in:'query', schema:{type:'boolean'} }
    #swagger.parameters['limit']     = { in:'query', schema:{type:'integer',minimum:1,maximum:200}, default:50 }
    #swagger.parameters['offset']    = { in:'query', schema:{type:'integer',minimum:0}, default:0 }
  */
  try {
    const { q } = req.query
    const is_active = (req.query.is_active ?? '').toString().toLowerCase()
    let { limit = 50, offset = 0 } = req.query
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
    offset = Math.max(parseInt(offset, 10) || 0, 0)

    const where = []
    const params = []
    let i = 1

    if (isNonEmptyString(q)) {
      where.push(`(display_name ILIKE $${i} OR email ILIKE $${i} OR phone ILIKE $${i})`)
      params.push(`%${q.trim()}%`); i++
    }
    if (is_active === 'true') where.push('is_active = true')
    if (is_active === 'false') where.push('is_active = false')

    const sql = `
      SELECT id, first_name, last_name, display_name, email, phone,
             role, color, is_active, hired_at, terminated_at, created_at
      FROM employees
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY display_name ASC
      LIMIT ${limit} OFFSET ${offset}
    `
    const { rows } = await client.query(sql, params)
    res.status(200).json(rows)
  } catch (e) { next(e) }
})

// CREATE
router.post('/', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db

  /*
    #swagger.tags = ['Employees']
    #swagger.requestBody = { required:true, content:{"application/json":{
      schema:{ type:'object', required:['display_name'],
        properties:{
          display_name:{type:'string'}, first_name:{type:'string'}, last_name:{type:'string'},
          email:{type:'string'}, phone:{type:'string'}, role:{type:'string', default:'staff'},
          color:{type:'string'}, is_active:{type:'boolean', default:true},
          hired_at:{type:'string', format:'date'}, terminated_at:{type:'string', format:'date'}
        }
      }
    }}}
  */
  try {
    const {
      display_name, first_name, last_name,
      email, phone, role = 'staff',
      color = null, is_active = true,
      hired_at = null, terminated_at = null
    } = req.body || {}

    if (!isNonEmptyString(display_name)) return res.status(400).json({ error: 'display_name is required' })

    const { rows } = await client.query(
      `INSERT INTO employees
         (tenant_id, display_name, first_name, last_name, email, phone, role, color, is_active, hired_at, terminated_at)
       VALUES (current_setting('app.tenant_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, first_name, last_name, display_name, email, phone,
                 role, color, is_active, hired_at, terminated_at, created_at`,
      [display_name.trim(), first_name ?? null, last_name ?? null, email ?? null, phone ?? null,
        role ?? 'staff', color, !!is_active, hired_at, terminated_at]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'display_name must be unique per tenant' })
    next(e)
  }
})

// UPDATE (partial)
router.put('/:employeeId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  try {
    const { employeeId } = req.params
    const {
      display_name, first_name, last_name, email, phone, role,
      color, is_active, hired_at, terminated_at
    } = req.body || {}

    const f = []; const v = []; let i = 1
    if (display_name !== undefined) { if (!isNonEmptyString(display_name)) return res.status(400).json({ error: 'display_name must be non-empty' }); f.push(`display_name=$${i++}`); v.push(display_name.trim()) }
    if (first_name !== undefined) { f.push(`first_name=$${i++}`); v.push(first_name ?? null) }
    if (last_name !== undefined) { f.push(`last_name=$${i++}`); v.push(last_name ?? null) }
    if (email !== undefined) { f.push(`email=$${i++}`); v.push(email ?? null) }
    if (phone !== undefined) { f.push(`phone=$${i++}`); v.push(phone ?? null) }
    if (role !== undefined) { f.push(`role=$${i++}`); v.push(role ?? 'staff') }
    if (color !== undefined) { f.push(`color=$${i++}`); v.push(color ?? null) }
    if (is_active !== undefined) { f.push(`is_active=$${i++}`); v.push(!!is_active) }
    if (hired_at !== undefined) { f.push(`hired_at=$${i++}`); v.push(hired_at ?? null) }
    if (terminated_at !== undefined) { f.push(`terminated_at=$${i++}`); v.push(terminated_at ?? null) }
    if (!f.length) return res.status(400).json({ error: 'no updatable fields provided' })

    v.push(employeeId)
    const { rows } = await client.query(
      `UPDATE employees SET ${f.join(', ')} WHERE id=$${i}
       RETURNING id, first_name, last_name, display_name, email, phone,
                 role, color, is_active, hired_at, terminated_at, created_at`,
      v
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.status(200).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'display_name must be unique per tenant' })
    next(e)
  }
})

// DELETE
router.delete('/:employeeId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  try {
    const { employeeId } = req.params
    const r = await client.query('DELETE FROM employees WHERE id=$1 RETURNING id', [employeeId])
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) {
    // bookings.employee_id is ON DELETE RESTRICT → 23503
    if (e.code === '23503') return res.status(400).json({ error: 'employee is used in bookings' })
    next(e)
  }
})

// ---------- Employee ↔ Services (skills) ----------

// List assigned services
router.get('/:employeeId/services', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  try {
    const { rows } = await client.query(
      `SELECT es.id, es.employee_id, es.service_id, es.created_at,
              s.name AS service_name, s.duration_min, s.price, s.is_active
       FROM employee_services es
       JOIN services s ON s.id = es.service_id
       WHERE es.employee_id = $1
       ORDER BY s.name ASC`,
      [employeeId]
    )
    res.status(200).json(rows)
  } catch (e) { next(e) }
})

// Assign one service
router.post('/:employeeId/services', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  const { service_id } = req.body || {}

  try {
    if (!isUUID(service_id)) return res.status(400).json({ error: 'service_id must be uuid' })
    const { rows } = await client.query(
      `INSERT INTO employee_services (employee_id, service_id)
       VALUES ($1, $2)
       RETURNING id, employee_id, service_id, created_at`,
      [employeeId, service_id]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'service already assigned' })
    // Trigger/FK/tenant mismatch → 400
    if (e.code === '23503' || e.code === 'P0001') return res.status(400).json({ error: e.message })
    next(e)
  }
})

// Unassign one service
router.delete('/:employeeId/services/:linkId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { linkId } = req.params
  try {
    const r = await client.query('DELETE FROM employee_services WHERE id=$1 RETURNING id', [linkId])
    if (!r.rowCount) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) { next(e) }
})

// Bulk replace assigned services
router.put('/:employeeId/services/bulk', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  const { service_ids } = req.body || {}
  try {
    if (!Array.isArray(service_ids)) return res.status(400).json({ error: 'service_ids must be array of uuids' })
    for (const id of service_ids) if (!isUUID(id)) return res.status(400).json({ error: 'service_ids contains non-uuid' })

    await client.query('BEGIN')
    try {
      await client.query('DELETE FROM employee_services WHERE employee_id=$1', [employeeId])
      const inserted = []
      for (const sid of service_ids) {
        const r = await client.query(
          `INSERT INTO employee_services (employee_id, service_id)
           VALUES ($1, $2)
           RETURNING id, employee_id, service_id, created_at`,
          [employeeId, sid]
        )
        inserted.push(r.rows[0])
      }
      await client.query('COMMIT')
      res.status(200).json(inserted)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {};
      if (e.code === '23503' || e.code === 'P0001') return res.status(400).json({ error: e.message })
      if (e.code === '23505') return res.status(400).json({ error: 'duplicate service id' })
      throw e
    }
  } catch (e) { next(e) }
})

// ---------- Availability (weekly) ----------

router.get('/:employeeId/availability', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  try {
    const { rows } = await client.query(
      `SELECT id, employee_id, weekday, start_time, end_time, location, created_at
       FROM employee_availability
       WHERE employee_id = $1
       ORDER BY weekday ASC, start_time ASC`,
      [employeeId]
    )
    res.status(200).json(rows)
  } catch (e) { next(e) }
})

router.post('/:employeeId/availability', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  const { weekday, start_time, end_time, location } = req.body || {}
  try {
    const wd = Number(weekday)
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: 'weekday must be 0..6' })
    if (!isNonEmptyString(start_time) || !isNonEmptyString(end_time)) return res.status(400).json({ error: 'start_time & end_time required' })

    const { rows } = await client.query(
      `INSERT INTO employee_availability (employee_id, weekday, start_time, end_time, location)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, employee_id, weekday, start_time, end_time, location, created_at`,
      [employeeId, wd, start_time, end_time, location ?? null]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === 'P0001') return res.status(400).json({ error: e.message }) // trigger errors
    next(e)
  }
})

router.put('/:employeeId/availability/:availId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { availId } = req.params
  const { weekday, start_time, end_time, location } = req.body || {}
  try {
    const f = []; const v = []; let i = 1
    if (weekday !== undefined) { const wd = Number(weekday); if (!Number.isInteger(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: 'weekday must be 0..6' }); f.push(`weekday=$${i++}`); v.push(wd) }
    if (start_time !== undefined) { if (!isNonEmptyString(start_time)) return res.status(400).json({ error: 'start_time must be string' }); f.push(`start_time=$${i++}`); v.push(start_time) }
    if (end_time !== undefined) { if (!isNonEmptyString(end_time)) return res.status(400).json({ error: 'end_time must be string' }); f.push(`end_time=$${i++}`); v.push(end_time) }
    if (location !== undefined) { f.push(`location=$${i++}`); v.push(location ?? null) }
    if (!f.length) return res.status(400).json({ error: 'no updatable fields provided' })

    v.push(availId)
    const { rows } = await client.query(
      `UPDATE employee_availability SET ${f.join(', ')} WHERE id=$${i}
       RETURNING id, employee_id, weekday, start_time, end_time, location, created_at`,
      v
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.status(200).json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/:employeeId/availability/:availId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { availId } = req.params
  try {
    const r = await client.query('DELETE FROM employee_availability WHERE id=$1 RETURNING id', [availId])
    if (!r.rowCount) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) { next(e) }
})

// ---------- Time Off (exceptions) ----------

router.get('/:employeeId/time-off', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  try {
    const { rows } = await client.query(
      `SELECT id, employee_id, starts_at, ends_at, reason, created_at
       FROM employee_time_off
       WHERE employee_id = $1
       ORDER BY starts_at DESC`,
      [employeeId]
    )
    res.status(200).json(rows)
  } catch (e) { next(e) }
})

router.post('/:employeeId/time-off', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { employeeId } = req.params
  const { starts_at, ends_at, reason } = req.body || {}
  try {
    if (!isNonEmptyString(starts_at) || !isNonEmptyString(ends_at)) return res.status(400).json({ error: 'starts_at & ends_at required (ISO timestamp strings)' })

    const { rows } = await client.query(
      `INSERT INTO employee_time_off (employee_id, starts_at, ends_at, reason)
       VALUES ($1,$2,$3,$4)
       RETURNING id, employee_id, starts_at, ends_at, reason, created_at`,
      [employeeId, starts_at, ends_at, reason ?? null]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === 'P0001') return res.status(400).json({ error: e.message })
    next(e)
  }
})

router.put('/:employeeId/time-off/:timeOffId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { timeOffId } = req.params
  const { starts_at, ends_at, reason } = req.body || {}
  try {
    const f = []; const v = []; let i = 1
    if (starts_at !== undefined) { if (!isNonEmptyString(starts_at)) return res.status(400).json({ error: 'starts_at must be string' }); f.push(`starts_at=$${i++}`); v.push(starts_at) }
    if (ends_at !== undefined) { if (!isNonEmptyString(ends_at)) return res.status(400).json({ error: 'ends_at must be string' }); f.push(`ends_at=$${i++}`); v.push(ends_at) }
    if (reason !== undefined) { f.push(`reason=$${i++}`); v.push(reason ?? null) }
    if (!f.length) return res.status(400).json({ error: 'no updatable fields provided' })

    v.push(timeOffId)
    const { rows } = await client.query(
      `UPDATE employee_time_off SET ${f.join(', ')} WHERE id=$${i}
       RETURNING id, employee_id, starts_at, ends_at, reason, created_at`,
      v
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.status(200).json(rows[0])
  } catch (e) { next(e) }
})

router.delete('/:employeeId/time-off/:timeOffId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { timeOffId } = req.params
  try {
    const r = await client.query('DELETE FROM employee_time_off WHERE id=$1 RETURNING id', [timeOffId])
    if (!r.rowCount) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) { next(e) }
})

module.exports = router
