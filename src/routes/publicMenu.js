const express = require('express')
const router = express.Router()

// PUBLIC: Menü & Items (read-only)
router.get('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params
    // req.db ist gesetzt durch publicTenantContext(from:"menu")
    const menuQ = await req.db.query(
      'SELECT id, name, slug FROM menus WHERE slug=$1 AND is_public=true',
      [slug]
    )
    if (!menuQ.rowCount) return res.status(404).json({ error: 'Menu not found' })
    const menu = menuQ.rows[0]

    const itemsQ = await req.db.query(
      `SELECT mi.id, mi.product_id, mi.sort_index, p.name, p.price, p.vat_rate
       FROM menu_items mi
       JOIN products p ON p.id = mi.product_id
       WHERE mi.menu_id = $1
       ORDER BY mi.sort_index ASC, p.name ASC`,
      [menu.id]
    )

    res.json({ menu, items: itemsQ.rows })
  } catch (e) { next(e) }
})

module.exports = router
