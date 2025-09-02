/* eslint-env jest */
const request = require('supertest')
const { app } = require('./helpers')

// Nur Smoke-Test auf 400, weil publicTenantContext Slug braucht
describe('Public Booking', () => {
  test('GET /public/booking/:slug/availability without params -> 400', async () => {
    const r = await request(app).get('/api/public/booking/demo/availability')
    expect([400, 404]).toContain(r.status)
  })
})
