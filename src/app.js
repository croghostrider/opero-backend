'use strict'

require('dotenv').config({ path: '../.env' })

const express = require('express')
const morgan = require('morgan')
const cors = require('cors')
const bodyParser = require('body-parser')
const { Pool } = require('pg')
// const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express')
// const { swaggerJsdocOptions } = require('./docs/swagger');
// const openapiSpec = swaggerJsdoc(swaggerJsdocOptions);

let openapiSpec
try {
  // Generierte Datei laden
  openapiSpec = require('./docs/swagger-output.json')
} catch (e) {
  console.warn('⚠️  Swagger-Output noch nicht generiert. Bitte "npm run docs:gen" ausführen.')
  openapiSpec = { openapi: '3.0.0', info: { title: 'Opero API', version: '0.0.0' } }
}

// Middleware
const auth = require('./middleware/auth')
const tenantContext = require('./middleware/tenantContext')
const publicTenantContext = require('./middleware/publicTenantContext')
// const { loadSubscription } = require('./middleware/subscription');

// Routen
const authRouter = require('./routes/auth')
const billingRouter = require('./routes/billing')
const bookingsRouter = require('./routes/bookings')
const inventoryRouter = require('./routes/inventory')
const menusRouter = require('./routes/menus')
const ordersRouter = require('./routes/orders')
const productsRouter = require('./routes/products')
const ingredientsRouter = require('./routes/ingredients')
const productIngredientsRouter = require('./routes/products.ingredients')
const publicBookingRouter = require('./routes/publicBooking')
const publicMenuRouter = require('./routes/publicMenu')
const publicReceiptRouter = require('./routes/publicReceipt')
const publicSelfOrderRouter = require('./routes/publicSelfOrder')
const servicesRouter = require('./routes/services')
const employeesRouter = require('./routes/employees')
// const stripeWebhookRouter = require('./routes/stripeWebhook');
const tablesRouter = require('./routes/tables')
const paymentsRouter = require('./payments/router')

// -----------------------------------------------------------------------------
// DB-Pool
// -----------------------------------------------------------------------------
function buildDbConfig () {
  const url = process.env.DATABASE_URL
  if (url) {
    // Robust parse
    const u = new URL(url)
    const cfg = {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      database: (u.pathname || '').replace(/^\//, ''),
      user: decodeURIComponent(u.username || ''),
      // ensure string (even if missing -> empty string)
      password: decodeURIComponent(u.password || ''),
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    }
    return cfg
  }
  // Fallback auf Einzel-ENV
  return {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE || 'opero',
    user: String(process.env.PGUSER || ''),
    password: String(process.env.PGPASSWORD || ''), // 👈 erzwinge String
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  }
}

const pool = new Pool(buildDbConfig())

// Hilfreiches Debug-Log (ohne Passwort)
// const cfg = buildDbConfig()
// console.log('DB →', {
//   host: cfg.host,
//   port: cfg.port,
//   database: cfg.database,
//   user: cfg.user,
//   // password absichtlich nicht loggen
// });

// Express-App
const app = express()
app.get('/docs.json', (_req, res) => res.json(openapiSpec))
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { explorer: true }))
app.set('pool', pool)
app.use(morgan('dev'))
app.use(cors({ origin: true, credentials: true }))
app.use(bodyParser.json({ limit: '5mb' }))

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------
app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

// -----------------------------------------------------------------------------
// Public Routes (kein JWT)
// -----------------------------------------------------------------------------
// Auth / Billing
app.use('/api/auth', authRouter)
app.use('/api/billing', billingRouter)
// app.use('/stripe/webhook', stripeWebhookRouter);

// Public (mit Tenant-Context via Menü-Slug)
app.use('/api/public/menu/:slug', publicTenantContext(pool, { from: 'menu' }), publicMenuRouter)
app.use('/api/public/self-order/:slug', publicTenantContext(pool, { from: 'menu' }), publicSelfOrderRouter)
// Receipt kann ohne Tenant-Context auskommen, wenn du direkt über receipt_code selektierst.
// Falls deine Implementation RLS erzwingt, setze hier ebenfalls publicTenantContext davor.
app.use('/api/public/receipt/:code', publicReceiptRouter)
app.use('/api/public/booking/:slug', publicTenantContext(pool, { from: 'menu' }), publicBookingRouter)

// -----------------------------------------------------------------------------
// Authenticated Tenant Routes (JWT → tenantContext → subscription)
// -----------------------------------------------------------------------------
app.use(auth)
app.use(tenantContext(pool))
// app.use(loadSubscription);

// Kernmodule
app.use('/api/bookings', bookingsRouter)
app.use('/api/inventory', inventoryRouter)
app.use('/api/menus', menusRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/products', productsRouter)
app.use('/api/ingredients', ingredientsRouter)
app.use('/api/products/:productId/ingredients', productIngredientsRouter)
app.use('/api/services', servicesRouter)
app.use('/api/employees', employeesRouter)
app.use('/api/tables', tablesRouter) // ✅ jetzt definiert
app.use('/api/pos', paymentsRouter)
// payments.mount(app);

// -----------------------------------------------------------------------------
// Error Handling
// -----------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.use((err, _req, res, _next) => {
  console.error('❌ Error:', err)
  res.status(500).json({ error: err.message || 'Internal Server Error' })
})

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
if (require.main === module) {
  const port = process.env.PORT || 4000
  app.listen(port, () => {
    console.log(`🚀 Opero backend running on http://localhost:${port}`)
  })
}

module.exports = app
