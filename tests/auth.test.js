/* eslint-env jest */
const request = require('supertest')
const app = require('../src/app')

describe('Auth', () => {
  test('signup returns JWT', async () => {
    const email = `user+${Date.now()}@example.com`
    const res = await request(app).post('/api/auth/signup').send({ email, password: 'pw123456' })
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('token')
  })

  test('login works after signup', async () => {
    const email = `user+${Date.now()}@example.com`
    const password = 'pw123456'
    const s = await request(app).post('/api/auth/signup').send({ email, password })
    expect(s.status).toBe(201)

    const l = await request(app).post('/api/auth/login').send({ email, password })
    expect(l.status).toBe(200)
    expect(l.body).toHaveProperty('token')
  })
})
