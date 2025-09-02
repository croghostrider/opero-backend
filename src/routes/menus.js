const express = require('express')
const router = express.Router()
const { requireFeature } = require('../middleware/subscription')

// ADMIN: Liste der Menüs
router.get('/', requireFeature('digital_menu'), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id, name, slug, is_public, created_at FROM menus ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// ADMIN: Menü anlegen
router.post('/', requireFeature('digital_menu'), async (req, res, next) => {
  const { name, slug, is_public = true } = req.body
  try {
    const { rows } = await req.db.query(
      `INSERT INTO menus (tenant_id, name, slug, is_public)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3)
       RETURNING id, name, slug, is_public, created_at`,
      [name, slug, is_public]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

// ADMIN: Menü-Items setzen (einfacher Replace)
router.put('/:id/items', requireFeature('digital_menu'), async (req, res, next) => {
  const { id } = req.params
  const { items } = req.body // [{product_id, sort_index}]
  try {
    await req.db.query('DELETE FROM menu_items WHERE menu_id = $1', [id])
    for (const it of items || []) {
      await req.db.query(
        `INSERT INTO menu_items (tenant_id, menu_id, product_id, sort_index)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3)`,
        [id, it.product_id, it.sort_index ?? 0]
      )
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
