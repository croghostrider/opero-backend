const { planAtLeast, hasFeature } = require('../billing/planFeatures')

const DEFAULT_PLAN = process.env.DEFAULT_PLAN || 'basic'
// Welche Status gelten als „aktiv“?
const ACTIVE_STATUSES = new Set(['trialing', 'active', 'past_due'])

async function loadSubscription (req, res, next) {
  try {
    // Tenant ist bereits gesetzt (auth + tenantContext)
    const { rows } = await req.db.query(
      `SELECT plan, interval, status, current_period_end
       FROM subscriptions
       WHERE tenant_id = current_setting('app.tenant_id')::uuid
       ORDER BY current_period_end DESC
       LIMIT 1`
    )

    let plan = DEFAULT_PLAN
    let interval = 'monthly'
    let status = 'none'
    let current_period_end = null

    if (rows.length) {
      const sub = rows[0]
      plan = sub.plan
      interval = sub.interval
      status = sub.status
      current_period_end = sub.current_period_end
      // Nur aktiv, wenn Status ok & nicht abgelaufen
      const isActive = ACTIVE_STATUSES.has(status) && (!current_period_end || new Date(current_period_end) > new Date())
      if (!isActive) {
        // fallback auf DEFAULT_PLAN (z. B. „basic“)
        plan = DEFAULT_PLAN
      }
    }

    req.subscription = { plan, interval, status, current_period_end }
    next()
  } catch (e) {
    next(e)
  }
}

// Middleware-Factory: Mindestplan verlangen
function requirePlan (minPlan) {
  return function (req, res, next) {
    const p = req.subscription?.plan || DEFAULT_PLAN
    if (!planAtLeast(p, minPlan)) {
      return res.status(403).json({ error: `Plan '${minPlan}' erforderlich` })
    }
    next()
  }
}

// Middleware-Factory: Feature verlangen
function requireFeature (feature) {
  return function (req, res, next) {
    const p = req.subscription?.plan || DEFAULT_PLAN
    if (!hasFeature(p, feature)) {
      return res.status(403).json({ error: `Feature '${feature}' in deinem Plan nicht enthalten` })
    }
    next()
  }
}

module.exports = { loadSubscription, requirePlan, requireFeature }
