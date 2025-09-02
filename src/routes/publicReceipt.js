const express = require('express')
const router = express.Router()

// PUBLIC: Beleg abrufen (nur kaufrelevante Daten)
router.get('/:code', async (req, res, next) => {
  try {
    const { code } = req.params
    const oQ = await req.db.query(
      `SELECT id, currency, subtotal, vat_total, grand_total, created_at
       FROM self_orders
       WHERE receipt_code=$1 AND status='paid'`,
      [code]
    )
    if (!oQ.rowCount) return res.status(404).json({ error: 'Receipt not found' })
    const order = oQ.rows[0]

    const itemsQ = await req.db.query(
      `SELECT soi.qty, soi.unit_price, soi.vat_rate, soi.line_total, p.name
       FROM self_order_items soi
       JOIN products p ON p.id = soi.product_id
       WHERE soi.self_order_id = $1`,
      [order.id]
    )

    res.json({ order, items: itemsQ.rows })
  } catch (e) { next(e) }
})

module.exports = router
