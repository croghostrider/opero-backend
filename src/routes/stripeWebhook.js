const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const { stripe } = require('../billing/stripe')
const bodyParser = require('body-parser')

// RAW body nötig für Stripe-Signatur
router.post('/stripe/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature']
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          // Subscription wurde angelegt
          const sess = event.data.object
          const subId = sess.subscription
          // customer → tenant_id ermitteln
          const customerId = sess.customer
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const r = await client.query(
              'SELECT tenant_id FROM stripe_customers WHERE stripe_id=$1',
              [customerId]
            )
            if (r.rowCount) {
              // Stripe Subscription laden, Plan/Interval auslesen
              const sub = await stripe.subscriptions.retrieve(subId)
              const item = sub.items.data[0]
              const price = item.price
              const plan = (price.nickname || price.product?.name || '').toLowerCase().includes('premium')
                ? 'premium'
                : ((price.nickname || '').toLowerCase().includes('pro') ? 'pro' : 'basic')
              const interval = price.recurring.interval === 'year' ? 'yearly' : 'monthly'

              await client.query(
                `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan, interval, status, current_period_end)
                 VALUES ($1,$2,$3,$4,$5, to_timestamp($6))
                 ON CONFLICT (stripe_sub_id) DO UPDATE SET
                   plan=EXCLUDED.plan, interval=EXCLUDED.interval, status=EXCLUDED.status, current_period_end=EXCLUDED.current_period_end`,
                [r.rows[0].tenant_id, sub.id, plan, interval, sub.status, sub.current_period_end]
              )
            }
            await client.query('COMMIT')
          } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
          break
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await client.query(
              `UPDATE subscriptions
               SET status=$2, current_period_end=to_timestamp($3)
               WHERE stripe_sub_id=$1`,
              [sub.id, sub.status, sub.current_period_end]
            )
            await client.query('COMMIT')
          } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
          break
        }
        default:
          // andere Events optional loggen
          break
      }
      res.json({ received: true })
    } catch (err) {
      console.error(err)
      res.status(500).end()
    }
  }
)

module.exports = router
