const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const { stripe, PRICE_MAP } = require('../billing/stripe')

// Hole/erstelle Stripe Customer für Tenant
async function getOrCreateStripeCustomer (dbClient, tenantId, userEmail) {
  const ex = await dbClient.query(
    'SELECT stripe_id FROM stripe_customers WHERE tenant_id=$1', [tenantId]
  )
  if (ex.rowCount) return ex.rows[0].stripe_id

  const customer = await stripe.customers.create({ email: userEmail, metadata: { tenant_id: tenantId } })
  await dbClient.query(
    'INSERT INTO stripe_customers (tenant_id, stripe_id) VALUES ($1,$2)',
    [tenantId, customer.id]
  )
  return customer.id
}

// POST /billing/checkout  { plan: 'basic'|'pro'|'premium', interval: 'monthly'|'yearly' }
router.post('/checkout', async (req, res, next) => {
  const { plan, interval } = req.body
  if (!['basic', 'pro', 'premium'].includes(plan)) return res.status(400).json({ error: 'invalid plan' })
  if (!['monthly', 'yearly'].includes(interval)) return res.status(400).json({ error: 'invalid interval' })

  const priceId = PRICE_MAP[plan][interval]
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const stripeCustomerId = await getOrCreateStripeCustomer(client, req.user.tenantId, req.user.email || undefined)

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_BASE_URL}/billing/cancel`
        // Schweiz MwSt: Stripe Tax optional
        // automatic_tax: { enabled: true },
        // currency: 'chf' // von price
      })

      await client.query('COMMIT')
      res.json({ url: session.url })
    } catch (e) {
      await client.query('ROLLBACK'); throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

router.post('/portal', async (req, res, next) => {
  try {
    const c = await req.db.query(
      'SELECT stripe_id FROM stripe_customers WHERE tenant_id=$1',
      [req.user.tenantId]
    )
    if (!c.rowCount) return res.status(404).json({ error: 'no stripe customer' })
    const session = await stripe.billingPortal.sessions.create({
      customer: c.rows[0].stripe_id,
      return_url: `${process.env.APP_BASE_URL}/account`
    })
    res.json({ url: session.url })
  } catch (e) { next(e) }
})

module.exports = router
