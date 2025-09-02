/* eslint-env jest */
const { request, app, signupAndGetToken } = require('./helpers')
const jwt = require('jsonwebtoken')

// ---- Provider-Factory mocken ----
jest.mock('../src/payments/providers/factory', () => {
  return {
    makeProvider: (_provider, _config, _tenantId) => {
      return {
        // Start liefert eine externalId und einen "step"
        startPayment: async ({ paymentId }) => ({
          externalId: `mock_ext_${paymentId}`,
          step: 'awaiting_card'
        }),
        // Cancel tut "nichts" (würde beim echten Provider abbrechen)
        cancelPayment: async (_externalId) => true
      }
    }
  }
})

// ---- kleiner DB-Helper: aktiven Provider für diesen Tenant setzen ----
async function ensureActiveProviderForToken (app, token, provider = 'sumup') {
  const tid = jwt.decode(token)?.tenant_id || jwt.decode(token)?.tenantId
  if (!tid) throw new Error('tenant id missing in token')

  const pool = app.get('pool')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ❌ weg: await client.query(`SET LOCAL app.tenant_id = $1`, [tid]);
    // ✅ stattdessen:
    await client.query('SELECT set_config(\'app.tenant_id\', $1, true)', [tid])

    await client.query(
      `INSERT INTO payment_providers (tenant_id, provider, config, active)
       VALUES (current_setting('app.tenant_id')::uuid, $1, '{}'::jsonb, true)
       ON CONFLICT (tenant_id, provider) DO UPDATE
         SET active = EXCLUDED.active`,
      [provider]
    )

    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

describe('POS Terminal API', () => {
  let token

  beforeAll(async () => {
    ({ token } = await signupAndGetToken())
    await ensureActiveProviderForToken(app, token, 'sumup')
  })

  test('terminal charge → webhook approved → status shows approved', async () => {
    // Start terminal payment
    const start = await request(app)
      .post('/api/pos/terminal/charge')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 12.34, currency: 'CHF', provider: 'sumup' })

    expect(start.status).toBe(201)
    expect(start.body.status).toBe('in_progress')
    expect(start.body.provider).toBe('sumup')
    expect(typeof start.body.external_id).toBe('string')

    const paymentId = start.body.id
    const externalId = start.body.external_id

    // Provider schickt Webhook "approved"
    const wh = await request(app)
      .post('/api/pos/webhooks/sumup')
      .set('Authorization', `Bearer ${token}`)
      .send({ external_id: externalId, status: 'approved', rawTest: true })

    expect(wh.status).toBe(200)

    // Status abfragen: jetzt approved
    const s = await request(app)
      .get(`/api/pos/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)

    expect(s.status).toBe(200)
    expect(s.body.status).toBe('approved')
    // Events enthalten 'created' + 'status'
    const types = (s.body.events || []).map(e => e.type)
    expect(types).toEqual(expect.arrayContaining(['created', 'status']))
  })

  test('terminal charge → cancel while in_progress → cancelled', async () => {
    const start = await request(app)
      .post('/api/pos/terminal/charge')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 5.0, currency: 'CHF', provider: 'sumup' })

    expect(start.status).toBe(201)
    const paymentId = start.body.id

    const cancel = await request(app)
      .post(`/api/pos/payments/${paymentId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send()

    expect(cancel.status).toBe(200)
    expect(cancel.body.ok).toBe(true)

    const s = await request(app)
      .get(`/api/pos/payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(s.status).toBe(200)
    expect(s.body.status).toBe('cancelled')

    const hasCancelledEvent = (s.body.events || []).some(e => e.type === 'cancelled')
    expect(hasCancelledEvent).toBe(true)
  })

  test('terminal charge ohne Provider-Config (anderer Nutzer) → 400', async () => {
    // Neuer Benutzer (anderer Tenant) ohne Provider-Setup
    const { token: tokenB } = await signupAndGetToken()
    // NICHT ensureActiveProviderForToken() aufrufen

    const start = await request(app)
      .post('/api/pos/terminal/charge')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ amount: 9.99, currency: 'CHF', provider: 'sumup' })

    expect(start.status).toBe(400)
    expect(String(start.body.error || '')).toMatch(/no payment provider configured/i)
  })
})
