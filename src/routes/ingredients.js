'use strict'

const express = require('express')
const router = express.Router()

function isNonEmptyString (v) { return typeof v === 'string' && v.trim().length > 0 }
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function isUUID (v) { return typeof v === 'string' && UUID_RX.test(v) }

function assertClient (req, res) { if (!req.db) { res.status(500).json({ error: 'Tenant context DB client missing' }); return false } return true }

// LIST with search/pagination
router.get('/', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db

  /*
    #swagger.tags = ['Ingredients']
    #swagger.parameters['q'] = { in: 'query', schema:{type:'string'} }
    #swagger.parameters['limit'] = { in:'query', schema:{type:'integer',minimum:1,maximum:200}, default:50 }
    #swagger.parameters['offset'] = { in:'query', schema:{type:'integer',minimum:0}, default:0 }
  */
  try {
    const { q } = req.query
    let { limit = 50, offset = 0 } = req.query
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
    offset = Math.max(parseInt(offset, 10) || 0, 0)

    const where = []
    const params = []
    let i = 1

    if (isNonEmptyString(q)) {
      where.push(`name ILIKE $${i}`); params.push(`%${q.trim()}%`); i++
    }

    const sql = `
      SELECT id, name, allergen_codes, metadata, created_at
      FROM ingredients
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
    #swagger.tags = ['Ingredients']
    #swagger.requestBody = {
      required: true, content: { "application/json": {
        schema: { type:'object', required:['name'],
          properties:{
            name:{type:'string'}, allergen_codes:{type:'array', items:{type:'string'}},
            metadata:{type:'object'}
          } } } }
    }
  */
  try {
    const { name, allergen_codes, metadata } = req.body || {}
    if (!isNonEmptyString(name)) return res.status(400).json({ error: 'name is required (non-empty string)' })

    const codes = Array.isArray(allergen_codes) ? allergen_codes.map(String) : []
    const meta = (metadata && typeof metadata === 'object') ? metadata : {}

    const { rows } = await client.query(
      `INSERT INTO ingredients (tenant_id, name, allergen_codes, metadata)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3)
       RETURNING id, name, allergen_codes, metadata, created_at`,
      [name.trim(), codes, meta]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'ingredient name must be unique per tenant' })
    next(e)
  }
})

// UPDATE
router.put('/:id', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db

  try {
    const { id } = req.params
    const { name, allergen_codes, metadata } = req.body || {}

    const fields = []
    const vals = []
    let i = 1

    if (name !== undefined) {
      if (!isNonEmptyString(name)) return res.status(400).json({ error: 'name must be non-empty string' })
      fields.push(`name = $${i++}`); vals.push(name.trim())
    }
    if (allergen_codes !== undefined) {
      if (!Array.isArray(allergen_codes)) return res.status(400).json({ error: 'allergen_codes must be array of strings' })
      fields.push(`allergen_codes = $${i++}`); vals.push(allergen_codes.map(String))
    }
    if (metadata !== undefined) {
      if (metadata !== null && typeof metadata !== 'object') return res.status(400).json({ error: 'metadata must be object or null' })
      fields.push(`metadata = $${i++}`); vals.push(metadata ?? {})
    }
    if (fields.length === 0) return res.status(400).json({ error: 'no updatable fields provided' })

    vals.push(id)
    const { rows } = await client.query(
      `UPDATE ingredients SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, name, allergen_codes, metadata, created_at`,
      vals
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    res.status(200).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'ingredient name must be unique per tenant' })
    next(e)
  }
})

// DELETE
router.delete('/:id', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db

  try {
    const { id } = req.params
    // Hinweis: FK product_ingredients ON DELETE RESTRICT → 23503 wenn noch verwendet
    const r = await client.query('DELETE FROM ingredients WHERE id = $1 RETURNING id', [id])
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'ingredient is used in products' })
    next(e)
  }
})

module.exports = router
