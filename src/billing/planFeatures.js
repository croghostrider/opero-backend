// Reihenfolge bestimmt ">= Plan" Logik
const PLAN_ORDER = ['basic', 'pro', 'premium']
const PLAN_RANK = Object.fromEntries(PLAN_ORDER.map((p, i) => [p, i]))

// muss zum Frontend-Export FEATURES_BY_PLAN passen
const FEATURES_BY_PLAN = {
  basic: ['pos', 'receipts', 'vat_basic', 'email_support'],
  pro: ['pos', 'receipts', 'vat_reports', 'inventory', 'crm_light', 'locations_reporting', 'email_phone_support'],
  premium: ['pos', 'receipts', 'vat_reports', 'inventory', 'crm_light', 'locations_reporting', 'multisite', 'qr_ordering', 'staff_export', 'analytics_export', 'priority_support']
}

function hasFeature (plan, feature) {
  const list = FEATURES_BY_PLAN[plan] || []
  return list.includes(feature)
}

function planAtLeast (plan, minPlan) {
  return (PLAN_RANK[plan] ?? -1) >= (PLAN_RANK[minPlan] ?? 99)
}

module.exports = { PLAN_ORDER, PLAN_RANK, FEATURES_BY_PLAN, hasFeature, planAtLeast }
