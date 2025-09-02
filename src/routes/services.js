'use strict'

const express = require('express')
const router = express.Router()

function isNonEmptyString (v) { return typeof v === 'string' && v.trim().length > 0 }
function isNumberLike (v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) }
function assertClient (req, res) { if (!req.db) { res.status(500).json({ error: 'Tenant context DB client missing' }); return false } return true }

// LIST (Filter + Pagination)
router.get('/', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db

  /*
    #swagger.tags = ['Services']
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

    if (isNonEmptyString(q)) { where.push(`name ILIKE $${i}`); params.push(`%${q.trim()}%`); i++ }
    if (is_active === 'true') { where.push('is_active = true') }
    if (is_active === 'false') { where.push('is_active = false') }

    const sql = `
      SELECT id, name, description, duration_min, buffer_before_min, buffer_after_min,
             price, currency, color, is_active, created_at
      FROM services
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY name ASC
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
    #swagger.tags = ['Services']
    #swagger.requestBody = { required:true, content: {"application/json":{
      schema:{ type:'object', required:['name','duration_min'],
        properties:{
          name:{type:'string'}, description:{type:'string'},
          duration_min:{type:'integer', minimum:1},
          buffer_before_min:{type:'integer', minimum:0}, buffer_after_min:{type:'integer', minimum:0},
          price:{type:'number', minimum:0}, currency:{type:'string', default:'CHF'},
          color:{type:'string'}, is_active:{type:'boolean', default:true}
        }
      }
    }}}
  */
  try {
    const {
      name, description, duration_min,
      buffer_before_min = 0, buffer_after_min = 0,
      price = null, currency = 'CHF',
      color = null, is_active = true
    } = req.body || {}

    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'name is required' })
    if (!Number.isInteger(duration_min) || duration_min <= 0) return res.status(400).json({ error: 'duration_min must be integer > 0' })
    if (!Number.isInteger(buffer_before_min) || buffer_before_min < 0) return res.status(400).json({ error: 'buffer_before_min must be integer >= 0' })
    if (!Number.isInteger(buffer_after_min) || buffer_after_min < 0) return res.status(400).json({ error: 'buffer_after_min must be integer >= 0' })
    if (price !== null && !isNumberLike(price)) return res.status(400).json({ error: 'price must be number or null' })

    const { rows } = await client.query(
      `INSERT INTO services
       (tenant_id, name, description, duration_min, buffer_before_min, buffer_after_min,
        price, currency, color, is_active)
       VALUES (current_setting('app.tenant_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, description, duration_min, buffer_before_min, buffer_after_min,
                 price, currency, color, is_active, created_at`,
      [
        name.trim(), description ?? null, duration_min,
        buffer_before_min, buffer_after_min,
        (price === null ? null : Number(price)), currency, color, !!is_active
      ]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

// UPDATE (partial)
router.put('/:id', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  try {
    const { id } = req.params
    const {
      name, description, duration_min,
      buffer_before_min, buffer_after_min,
      price, currency, color, is_active
    } = req.body || {}

    const f = []; const v = []; let i = 1
    if (name !== undefined) { if (!isNonEmptyString(name)) return res.status(400).json({ error: 'name must be non-empty' }); f.push(`name=$${i++}`); v.push(name.trim()) }
    if (description !== undefined) { f.push(`description=$${i++}`); v.push(description ?? null) }
    if (duration_min !== undefined) { if (!Number.isInteger(duration_min) || duration_min <= 0) return res.status(400).json({ error: 'duration_min must be integer > 0' }); f.push(`duration_min=$${i++}`); v.push(duration_min) }
    if (buffer_before_min !== undefined) { if (!Number.isInteger(buffer_before_min) || buffer_before_min < 0) return res.status(400).json({ error: 'buffer_before_min must be integer >= 0' }); f.push(`buffer_before_min=$${i++}`); v.push(buffer_before_min) }
    if (buffer_after_min !== undefined) { if (!Number.isInteger(buffer_after_min) || buffer_after_min < 0) return res.status(400).json({ error: 'buffer_after_min must be integer >= 0' }); f.push(`buffer_after_min=$${i++}`); v.push(buffer_after_min) }
    if (price !== undefined) {
      if (price !== null && !isNumberLike(price)) {
        return res.status(400).json({ error: 'price must be number or null' })
      }
      const n = (price === null) ? null : Number(price)
      if (n !== null && n < 0) {
        return res.status(400).json({ error: 'price must be >= 0' })
      }
      f.push(`price = $${i++}`)
      v.push(n)
    }
    if (currency !== undefined) { f.push(`currency=$${i++}`); v.push(currency ?? 'CHF') }
    if (color !== undefined) { f.push(`color=$${i++}`); v.push(color ?? null) }
    if (is_active !== undefined) { f.push(`is_active=$${i++}`); v.push(!!is_active) }

    if (!f.length) return res.status(400).json({ error: 'no updatable fields provided' })

    v.push(id)
    const { rows } = await client.query(
      `UPDATE services SET ${f.join(', ')} WHERE id=$${i}
       RETURNING id, name, description, duration_min, buffer_before_min, buffer_after_min,
                 price, currency, color, is_active, created_at`,
      v
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    res.status(200).json(rows[0])
  } catch (e) { next(e) }
})

// DELETE
router.delete('/:id', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  try {
    const { id } = req.params
    const r = await client.query('DELETE FROM services WHERE id=$1 RETURNING id', [id])
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) {
    // bookings.service_id has ON DELETE RESTRICT → 23503
    if (e.code === '23503') return res.status(400).json({ error: 'service is used in bookings' })
    next(e)
  }
})

module.exports = router
