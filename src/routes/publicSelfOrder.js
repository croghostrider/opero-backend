const express = require('express')
const crypto = require('crypto')
const { stripe } = require('../billing/stripe')
const router = express.Router()

/**
 * Self-Order Session anlegen (cart)
 * body: { menu_id, table_token? }
 * returns: { self_order_id }
 */
router.post('/session', async (req, res, next) => {
  try {
    const { menu_id, table_token } = req.body

    let tableId = null
    if (table_token) {
      const t = await req.db.query('SELECT id FROM tables WHERE qr_token=$1 AND is_active=true', [table_token])
      if (!t.rowCount) return res.status(404).json({ error: 'Table not found' })
      tableId = t.rows[0].id
    }

    const { rows } = await req.db.query(
      `INSERT INTO self_orders (tenant_id, menu_id, table_id, status)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'cart')
       RETURNING id`,
      [menu_id, tableId]
    )

    res.status(201).json({ self_order_id: rows[0].id })
  } catch (e) { next(e) }
})

/**
 * Position hinzufügen/ändern
 * body: { self_order_id, product_id, qty }
 */
router.post('/line', async (req, res, next) => {
  try {
    const { self_order_id, product_id, qty } = req.body
    // Produktdaten holen
    const p = await req.db.query('SELECT id, price, vat_rate FROM products WHERE id=$1', [product_id])
    if (!p.rowCount) return res.status(404).json({ error: 'Product not found' })
    const prod = p.rows[0]

    // einfache Logik: neue Zeile immer hinzufügen (kein Merge)
    const line_total = Number(qty) * Number(prod.price)
    await req.db.query(
      `INSERT INTO self_order_items (tenant_id, self_order_id, product_id, qty, unit_price, vat_rate, line_total)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)`,
      [self_order_id, product_id, qty, prod.price, prod.vat_rate, line_total]
    )

    // Summen neu berechnen
    const sumQ = await req.db.query(
      `SELECT
         COALESCE(SUM(line_total),0) AS subtotal,
         COALESCE(SUM(line_total * (vat_rate/100.0)),0) AS vat_total
       FROM self_order_items
       WHERE self_order_id=$1`,
      [self_order_id]
    )
    const subtotal = Number(sumQ.rows[0].subtotal)
    const vat_total = Number(sumQ.rows[0].vat_total)
    const grand_total = subtotal + vat_total

    await req.db.query(
      'UPDATE self_orders SET subtotal=$2, vat_total=$3, grand_total=$4 WHERE id=$1',
      [self_order_id, subtotal, vat_total, grand_total]
    )

    res.json({ ok: true, totals: { subtotal, vat_total, grand_total } })
  } catch (e) { next(e) }
})

/**
 * Checkout (PaymentIntent vorbereiten) – Stripe Skeleton
 * body: { self_order_id }
 * returns: { client_secret }
 */
router.post('/checkout', async (req, res, next) => {
  try {
    const { self_order_id } = req.body
    const q = await req.db.query(
      "SELECT id, currency, grand_total FROM self_orders WHERE id=$1 AND status='cart'",
      [self_order_id]
    )
    if (!q.rowCount) return res.status(404).json({ error: 'Order not found or not in cart' })
    const order = q.rows[0]

    // Betrag in Rappen
    const amount = Math.round(Number(order.grand_total) * 100)

    // Optional: Stripe Customer je Tenant wiederverwenden (aus stripe_customers)
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: (order.currency || 'CHF').toLowerCase(),
      automatic_payment_methods: { enabled: true }, // Apple/Google Pay inkl. Karten
      metadata: { self_order_id: order.id }
    })

    await req.db.query(
      "UPDATE self_orders SET payment_intent_id=$2, status='placed' WHERE id=$1",
      [order.id, pi.id]
    )

    res.json({ client_secret: pi.client_secret })
  } catch (e) { next(e) }
})

/**
 * Payment Bestätigung (Webhook in echt) – hier vereinfachter Poll-Endpoint
 * body: { self_order_id }
 * returns: { status }
 */
router.post('/confirm', async (req, res, next) => {
  try {
    const { self_order_id } = req.body
    const q = await req.db.query(
      'SELECT payment_intent_id FROM self_orders WHERE id=$1',
      [self_order_id]
    )
    if (!q.rowCount) return res.status(404).json({ error: 'Order not found' })

    const pi = await stripe.paymentIntents.retrieve(q.rows[0].payment_intent_id)
    if (pi.status === 'succeeded') {
      // kurze Beleg-ID generieren
      const code = crypto.randomBytes(4).toString('base64url')
      await req.db.query(
        "UPDATE self_orders SET status='paid', receipt_code=$2 WHERE id=$1",
        [self_order_id, code]
      )
    }
    res.json({ status: pi.status })
  } catch (e) { next(e) }
})

module.exports = router
