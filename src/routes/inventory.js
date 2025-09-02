const express = require('express')
const router = express.Router()
const { requirePlan, requireFeature } = require('../middleware/subscription')

// Variante A: Mindestplan
router.get('/stock', requirePlan('pro'), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      "SELECT id, name, qty, unit FROM inventory WHERE tenant_id = current_setting('app.tenant_id')::uuid ORDER BY name"
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// Variante B: Konkretes Feature („inventory“)
router.post('/adjust', requireFeature('inventory'), async (req, res, next) => {
  const { item_id, delta } = req.body
  try {
    await req.db.query(
      `UPDATE inventory
       SET qty = qty + $1
       WHERE id = $2 AND tenant_id = current_setting('app.tenant_id')::uuid`,
      [delta, item_id]
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
