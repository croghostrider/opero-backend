'use strict'

const express = require('express')
const router = express.Router({ mergeParams: true })

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function isUUID (v) { return typeof v === 'string' && UUID_RX.test(v) }
function isNonEmptyString (v) { return typeof v === 'string' && v.trim().length > 0 }
function isNumberLike (v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) }
function assertClient (req, res) { if (!req.db) { res.status(500).json({ error: 'Tenant context DB client missing' }); return false } return true }

// Helper: Produkt prüfen (existiert & ist kind='food')
async function requireFoodProduct (client, productId) {
  if (!isUUID(productId)) return { status: 400, error: 'invalid productId' }
  const r = await client.query('SELECT id, kind FROM products WHERE id = $1', [productId])
  if (r.rowCount === 0) return { status: 404, error: 'product not found' }
  if (r.rows[0].kind !== 'food') return { status: 400, error: 'product is not of kind=food' }
  return { ok: true }
}

// LIST lines for a product
router.get('/', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { productId } = req.params

  try {
    const chk = await requireFoodProduct(client, productId)
    if (!chk.ok) return res.status(chk.status).json({ error: chk.error })

    const { rows } = await client.query(
      `SELECT
          pi.id, pi.product_id, pi.ingredient_id, pi.quantity, pi.unit, pi.notes, pi.created_at,
          i.name AS ingredient_name, i.allergen_codes, i.metadata AS ingredient_metadata
       FROM product_ingredients pi
       JOIN ingredients i ON i.id = pi.ingredient_id
       WHERE pi.product_id = $1
       ORDER BY i.name ASC`,
      [productId]
    )
    res.status(200).json(rows)
  } catch (e) { next(e) }
})

// CREATE one line
router.post('/', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { productId } = req.params

  /*
    #swagger.tags = ['Product Ingredients']
    #swagger.requestBody = {
      required: true,
      content: { "application/json": {
        schema: { type:'object', required:['ingredient_id','quantity','unit'],
          properties:{
            ingredient_id:{type:'string',format:'uuid'},
            quantity:{type:'number',minimum:0},
            unit:{type:'string',example:'g'},
            notes:{type:'string'}
          } } } }
    }
  */
  try {
    const chk = await requireFoodProduct(client, productId)
    if (!chk.ok) return res.status(chk.status).json({ error: chk.error })

    const { ingredient_id, quantity, unit, notes } = req.body || {}
    if (!isUUID(ingredient_id)) return res.status(400).json({ error: 'ingredient_id must be uuid' })
    if (!isNumberLike(quantity) || Number(quantity) < 0) return res.status(400).json({ error: 'quantity must be >= 0' })
    if (!isNonEmptyString(unit)) return res.status(400).json({ error: 'unit is required' })

    const { rows } = await client.query(
      `INSERT INTO product_ingredients (product_id, ingredient_id, quantity, unit, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, product_id, ingredient_id, quantity, unit, notes, created_at`,
      [productId, ingredient_id, Number(quantity), unit.trim(), notes ?? null]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'ingredient already exists in this product' })
    // 23503/raise exception von Trigger → 400
    if (e.code === '23503' || e.code === 'P0001') return res.status(400).json({ error: e.message })
    next(e)
  }
})

// UPDATE one line
router.put('/:lineId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { productId, lineId } = req.params

  try {
    const chk = await requireFoodProduct(client, productId)
    if (!chk.ok) return res.status(chk.status).json({ error: chk.error })

    if (!isUUID(lineId)) return res.status(400).json({ error: 'invalid lineId' })

    const { ingredient_id, quantity, unit, notes } = req.body || {}

    const fields = []
    const vals = []
    let i = 1

    // ingredient_id change (rare)
    if (ingredient_id !== undefined) {
      if (!isUUID(ingredient_id)) return res.status(400).json({ error: 'ingredient_id must be uuid' })
      fields.push(`ingredient_id = $${i++}`); vals.push(ingredient_id)
    }
    if (quantity !== undefined) {
      if (!isNumberLike(quantity) || Number(quantity) < 0) return res.status(400).json({ error: 'quantity must be >= 0' })
      fields.push(`quantity = $${i++}`); vals.push(Number(quantity))
    }
    if (unit !== undefined) {
      if (!isNonEmptyString(unit)) return res.status(400).json({ error: 'unit must be non-empty string' })
      fields.push(`unit = $${i++}`); vals.push(unit.trim())
    }
    if (notes !== undefined) {
      fields.push(`notes = $${i++}`); vals.push(notes ?? null)
    }
    if (fields.length === 0) return res.status(400).json({ error: 'no updatable fields provided' })

    vals.push(lineId, productId)
    const { rows } = await client.query(
      `UPDATE product_ingredients
          SET ${fields.join(', ')}
        WHERE id = $${i++} AND product_id = $${i}
        RETURNING id, product_id, ingredient_id, quantity, unit, notes, created_at`,
      vals
    )

    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    res.status(200).json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'ingredient already exists in this product' })
    if (e.code === '23503' || e.code === 'P0001') return res.status(400).json({ error: e.message })
    next(e)
  }
})

// DELETE one line
router.delete('/:lineId', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { productId, lineId } = req.params

  try {
    if (!isUUID(lineId)) return res.status(400).json({ error: 'invalid lineId' })
    const r = await client.query(
      'DELETE FROM product_ingredients WHERE id = $1 AND product_id = $2 RETURNING id',
      [lineId, productId]
    )
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' })
    res.status(204).send()
  } catch (e) { next(e) }
})

// BULK REPLACE all lines for a product (idempotent)
router.put('/bulk', async (req, res, next) => {
  if (!assertClient(req, res)) return
  const client = req.db
  const { productId } = req.params

  /*
    #swagger.tags = ['Product Ingredients']
    #swagger.summary = 'Rezeptur komplett ersetzen'
    #swagger.requestBody = { required:true, content:{ "application/json":{
      schema:{ type:'object', required:['lines'], properties:{
        lines:{ type:'array', items:{ type:'object', required:['ingredient_id','quantity','unit'],
          properties:{ ingredient_id:{type:'string',format:'uuid'}, quantity:{type:'number',minimum:0}, unit:{type:'string'}, notes:{type:'string'} } } }
      } }
    } } }
  */
  try {
    const chk = await requireFoodProduct(client, productId)
    if (!chk.ok) return res.status(chk.status).json({ error: chk.error })

    const { lines } = req.body || {}
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array' })
    if (lines.length === 0) return res.status(200).json([]) // allow empty recipe

    // Basic validation first
    for (const [ix, ln] of lines.entries()) {
      if (!ln || !isUUID(ln.ingredient_id)) return res.status(400).json({ error: `lines[${ix}].ingredient_id must be uuid` })
      if (!isNumberLike(ln.quantity) || Number(ln.quantity) < 0) return res.status(400).json({ error: `lines[${ix}].quantity must be >= 0` })
      if (!isNonEmptyString(ln.unit)) return res.status(400).json({ error: `lines[${ix}].unit required` })
    }

    await client.query('BEGIN')
    try {
      await client.query('DELETE FROM product_ingredients WHERE product_id = $1', [productId])

      const inserted = []
      for (const ln of lines) {
        const { rows } = await client.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, quantity, unit, notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, product_id, ingredient_id, quantity, unit, notes, created_at`,
          [productId, ln.ingredient_id, Number(ln.quantity), ln.unit.trim(), ln.notes ?? null]
        )
        inserted.push(rows[0])
      }
      await client.query('COMMIT')
      return res.status(200).json(inserted)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      if (e.code === '23503' || e.code === 'P0001') return res.status(400).json({ error: e.message })
      if (e.code === '23505') return res.status(400).json({ error: 'duplicate ingredient in recipe' })
      throw e
    }
  } catch (e) { next(e) }
})

module.exports = router
