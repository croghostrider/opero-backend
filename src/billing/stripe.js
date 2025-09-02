const Stripe = require('stripe')
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const PRICE_MAP = {
  basic: { monthly: 'price_basic_monthly_id', yearly: 'price_basic_yearly_id' },
  pro: { monthly: 'price_pro_monthly_id', yearly: 'price_pro_yearly_id' },
  premium: { monthly: 'price_premium_monthly_id', yearly: 'price_premium_yearly_id' }
}

module.exports = { stripe, PRICE_MAP }
