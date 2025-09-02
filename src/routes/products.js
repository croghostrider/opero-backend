'use strict'

const express = require('express')
const router = express.Router()

// Alle Routen erwarten, dass auth + tenantContext vorher gelaufen sind
// und app.tenant_id in der DB-Session gesetzt ist (RLS) – oder wir filtern selbst via tenant_id.

function isNonEmptyString (v) {
  return typeof v === 'string' && v.trim().length > 0
}
function isNumberLike (v) {
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))
}
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function isUUID (v) {
  return typeof v === 'string' && UUID_RX.test(v)
}
const PRODUCT_KINDS = new Set(['food', 'goods'])

// LIST (mit Filtern & Pagination)
router.get('/', async (req, res, next) => {
  const client = req.db
  if (!client) return res.status(500).json({ error: 'Tenant context DB client missing' })

  /*
    #swagger.tags = ['Products']
    #swagger.summary = 'Alle Produkte abrufen'
    #swagger.parameters['kind'] = { in: 'query', schema: { type: 'string', enum: ['food','goods'] } }
    #swagger.parameters['category_id'] = { in: 'query', schema: { type: 'string', format: 'uuid' } }
    #swagger.parameters['q'] = { in: 'query', schema: { type: 'string' }, description: 'Suche in name/sku' }
    #swagger.parameters['limit'] = { in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 }, default: 50 }
    #swagger.parameters['offset'] = { in: 'query', schema: { type: 'integer', minimum: 0 }, default: 0 }
  */
  try {
    const { kind, category_id, q } = req.query
    let { limit = 50, offset = 0 } = req.query

    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
    offset = Math.max(parseInt(offset, 10) || 0, 0)

    const where = []
    const params = []
    let i = 1

    if (kind && PRODUCT_KINDS.has(String(kind))) {
      where.push(`kind = $${i++}`)
      params.push(kind)
    }
    if (category_id && isUUID(category_id)) {
      where.push(`category_id = $${i++}`)
      params.push(category_id)
    }
    if (isNonEmptyString(q)) {
      where.push(`(name ILIKE $${i} OR sku ILIKE $${i})`)
      params.push(`%${q.trim()}%`)
      i++
    }

    const sql = `
      SELECT id, name, kind, sku, category_id, vat_rate, price, metadata, created_at
      FROM products
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
    const { rows } = await client.query(sql, params)
    return res.status(200).json(rows)
  } catch (e) {
    return next(e)
  }
})

// CREATE
router.post('/', async (req, res, next) => {
  const client = req.db
  if (!client) return res.status(500).json({ error: 'Tenant context DB client missing' })

  /*
    #swagger.tags = ['Products']
    #swagger.summary = 'Neues Produkt anlegen'
    #swagger.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: 'object',
            required: ['name','kind'],
            properties: {
              name:        { type: 'string', example: 'Pizza Margherita' },
              kind:        { type: 'string', enum: ['food','goods'], example: 'food' },
              price:       { type: 'number', minimum: 0, example: 12.5 },
              vat_rate:    { type: 'number', minimum: 0, example: 2.6 },
              sku:         { type: 'string', example: 'PIZ-MARG-001' },
              category_id: { type: 'string', format: 'uuid' },
              metadata:    { type: 'object', example: { plu: 123, tags: ['vegi'] } }
            }
          }
        }
      }
    }
  */
  try {
    const { name, kind, price, vat_rate, sku, category_id, metadata } = req.body || {}

    // Validierung
    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: 'name is required (non-empty string)' })
    }
    if (!isNonEmptyString(kind) || !PRODUCT_KINDS.has(String(kind))) {
      return res.status(400).json({ error: "kind is required and must be 'food' or 'goods'" })
    }

    let priceNum = null
    if (price !== undefined) {
      if (!isNumberLike(price)) return res.status(400).json({ error: 'price must be a number' })
      priceNum = Number(price)
      if (priceNum < 0) return res.status(400).json({ error: 'price must be >= 0' })
    }

    let vatNum = 2.6
    if (vat_rate !== undefined) {
      if (!isNumberLike(vat_rate)) return res.status(400).json({ error: 'vat_rate must be a number' })
      vatNum = Number(vat_rate)
      if (vatNum < 0) return res.status(400).json({ error: 'vat_rate must be >= 0' })
    }

    let categoryId = null
    if (category_id !== undefined) {
      if (category_id !== null && !isUUID(category_id)) {
        return res.status(400).json({ error: 'category_id must be a uuid' })
      }
      categoryId = category_id || null
      // Optionale Sicherheit: prüfen, ob Kategorie zum Tenant gehört
      if (categoryId) {
        const chk = await client.query(
          `SELECT 1 FROM product_categories
            WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::uuid`,
          [categoryId]
        )
        if (chk.rowCount === 0) {
          return res.status(400).json({ error: 'invalid category_id for this tenant' })
        }
      }
    }

    const meta = (metadata && typeof metadata === 'object') ? metadata : {}

    const insert = await client.query(
      `INSERT INTO products (tenant_id, name, kind, vat_rate, price, sku, category_id, metadata)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, kind, sku, category_id, vat_rate, price, metadata, created_at`,
      [name.trim(), kind, vatNum, priceNum, sku ?? null, categoryId, meta]
    )

    return res.status(201).json(insert.rows[0])
  } catch (e) {
    if (e && e.code === '23502') {
      return res.status(400).json({ error: 'missing required field(s)' })
    }
    if (e && e.code === '23505') {
      return res.status(400).json({ error: 'duplicate value (e.g. sku must be unique per tenant)' })
    }
    return next(e)
  }
})

// UPDATE (partial)
router.put('/:id', async (req, res, next) => {
  const client = req.db
  if (!client) return res.status(500).json({ error: 'Tenant context DB client missing' })

  /*
    #swagger.tags = ['Products']
    #swagger.summary = 'Produkt ändern'
    #swagger.parameters['id'] = { in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
    #swagger.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: 'object',
            properties: {
              name:        { type: 'string' },
              price:       { type: 'number', minimum: 0 },
              vat_rate:    { type: 'number', minimum: 0 },
              kind:        { type: 'string', enum: ['food','goods'] },
              sku:         { type: 'string' },
              category_id: { type: 'string', format: 'uuid', nullable: true },
              metadata:    { type: 'object' }
            }
          }
        }
      }
    }
  */
  try {
    const { id } = req.params
    const { name, price, vat_rate, kind, sku, category_id, metadata } = req.body || {}

    const fields = []
    const values = []
    let idx = 1

    if (name !== undefined) {
      if (!isNonEmptyString(name)) return res.status(400).json({ error: 'name must be a non-empty string' })
      fields.push(`name = $${idx++}`)
      values.push(name.trim())
    }
    if (price !== undefined) {
      if (!isNumberLike(price)) return res.status(400).json({ error: 'price must be a number' })
      const n = Number(price)
      if (n < 0) return res.status(400).json({ error: 'price must be >= 0' })
      fields.push(`price = $${idx++}`)
      values.push(n)
    }
    if (vat_rate !== undefined) {
      if (!isNumberLike(vat_rate)) return res.status(400).json({ error: 'vat_rate must be a number' })
      const n = Number(vat_rate)
      if (n < 0) return res.status(400).json({ error: 'vat_rate must be >= 0' })
      fields.push(`vat_rate = $${idx++}`)
      values.push(n)
    }
    if (kind !== undefined) {
      if (!isNonEmptyString(kind) || !PRODUCT_KINDS.has(String(kind))) {
        return res.status(400).json({ error: "kind must be 'food' or 'goods'" })
      }
      // Wenn auf 'goods' umgestellt wird: vorhandene Rezepturen entfernen (sonst bleiben Leichen)
      if (String(kind) === 'goods') {
        await client.query('DELETE FROM product_ingredients WHERE product_id = $1', [id])
      }
      fields.push(`kind = $${idx++}`)
      values.push(kind)
    }
    if (sku !== undefined) {
      fields.push(`sku = $${idx++}`)
      values.push(sku === null ? null : String(sku))
    }
    if (category_id !== undefined) {
      if (category_id !== null && !isUUID(category_id)) {
        return res.status(400).json({ error: 'category_id must be a uuid or null' })
      }
      if (category_id) {
        const chk = await client.query(
          `SELECT 1 FROM product_categories
            WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::uuid`,
          [category_id]
        )
        if (chk.rowCount === 0) {
          return res.status(400).json({ error: 'invalid category_id for this tenant' })
        }
      }
      fields.push(`category_id = $${idx++}`)
      values.push(category_id)
    }
    if (metadata !== undefined) {
      if (metadata !== null && typeof metadata !== 'object') {
        return res.status(400).json({ error: 'metadata must be an object or null' })
      }
      fields.push(`metadata = $${idx++}`)
      values.push(metadata ?? {})
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'no updatable fields provided' })
    }

    values.push(id)
    const { rows } = await client.query(
      `UPDATE products
          SET ${fields.join(', ')}
        WHERE id = $${idx}
        RETURNING id, name, kind, sku, category_id, vat_rate, price, metadata, created_at`,
      values
    )

    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    return res.status(200).json(rows[0])
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(400).json({ error: 'duplicate value (e.g. sku must be unique per tenant)' })
    }
    return next(e)
  }
})

// DELETE
router.delete('/:id', async (req, res, next) => {
  const client = req.db
  if (!client) return res.status(500).json({ error: 'Tenant context DB client missing' })

  /*
    #swagger.tags = ['Products']
    #swagger.summary = 'Produkt löschen'
  */
  try {
    const { id } = req.params
    const r = await client.query(
      `DELETE FROM products
        WHERE id = $1
        RETURNING id`,
      [id]
    )
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' })
    return res.status(204).send()
  } catch (e) {
    return next(e)
  }
})

module.exports = router
