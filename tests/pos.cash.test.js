/* eslint-env jest */
const { request, app, signupAndGetToken } = require('./helpers')

describe('POS Cash API', () => {
  let token

  beforeAll(async () => {
    ({ token } = await signupAndGetToken())
  })

  test('cash charge → 201, approved + change + event', async () => {
    const r = await request(app)
      .post('/api/pos/cash/charge')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, tendered: 20, note: 'Kasse 1' })

    expect(r.status).toBe(201)
    expect(r.body.provider).toBe('cash')
    expect(r.body.status).toBe('approved')
    expect(r.body.amount).toBe('10.00') // numeric → string
    expect(r.body.tendered).toBe(20)
    expect(r.body.change).toBe(10)

    // Status + Events prüfen
    const s = await request(app)
      .get(`/api/pos/payments/${r.body.id}`)
      .set('Authorization', `Bearer ${token}`)

    expect(s.status).toBe(200)
    expect(Array.isArray(s.body.events)).toBe(true)
    // Ein approved-Event vorhanden?
    const hasApproved = s.body.events.some(e => e.type === 'approved')
    expect(hasApproved).toBe(true)
  })

  test('cash charge: tendered < amount → 400', async () => {
    const r = await request(app)
      .post('/api/pos/cash/charge')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, tendered: 5 })

    expect(r.status).toBe(400)
    expect(String(r.body.error || '')).toMatch(/tendered/i)
  })
})
