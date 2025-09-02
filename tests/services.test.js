/* eslint-env jest */
const { request, app, signupAndGetToken, signupTwoUsers, createService } = require('./helpers')

describe('Services API (auth, CRUD & tenant isolation)', () => {
  let token
  beforeAll(async () => {
    ({ token } = await signupAndGetToken())
  })

  // --- Auth ---
  test('GET /api/services ohne Token → 401', async () => {
    const r = await request(app).get('/api/services')
    expect(r.status).toBe(401)
  })

  test('GET /api/services mit Token → 200 (Array)', async () => {
    const r = await request(app)
      .get('/api/services')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  // --- CRUD-Flow ---
  test('create → list → update → delete', async () => {
    const created = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Haarschnitt', duration_min: 45, price: 39 })
    expect(created.status).toBe(201)
    const id = created.body.id

    const list = await request(app)
      .get('/api/services')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.find(s => s.id === id)?.name).toBe('Haarschnitt')

    const upd = await request(app)
      .put(`/api/services/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: 49, buffer_after_min: 5 })
    expect(upd.status).toBe(200)
    expect(upd.body.price).toBe('49.00')
    expect(upd.body.buffer_after_min).toBe(5)

    const del = await request(app)
      .delete(`/api/services/${id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)

    const listAfter = await request(app)
      .get('/api/services')
      .set('Authorization', `Bearer ${token}`)
    expect(listAfter.body.find(s => s.id === id)).toBeUndefined()
  })

  // --- Validierungen ---
  test('POST ohne name → 400', async () => {
    const r = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ duration_min: 30 })
    expect(r.status).toBe(400)
    expect(String(r.body.error || '')).toMatch(/name/i)
  })

  test('POST ohne duration_min → 400', async () => {
    const r = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Waschen' })
    expect(r.status).toBe(400)
    expect(String(r.body.error || '')).toMatch(/duration_min/i)
  })

  test('PUT mit negativem price → 400', async () => {
    const created = await createService(token, { name: 'InvalidTest', duration_min: 10, price: 1 })
    const upd = await request(app)
      .put(`/api/services/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: -5 })
    expect(upd.status).toBe(400)
    expect(String(upd.body.error || '')).toMatch(/price/i)
  })

  test('DELETE unbekannte ID → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const r = await request(app)
      .delete(`/api/services/${fakeId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(404)
  })

  // --- Tenant-Isolation ---
  test('User A sieht nur A-Services, User B nur B-Services', async () => {
    const { user1, user2 } = await signupTwoUsers()
    // A legt 2 Services an
    await createService(user1.token, { name: 'A-Only-1', duration_min: 20, price: 10 })
    await createService(user1.token, { name: 'A-Only-2', duration_min: 30, price: 11 })
    // B legt 1 Service an
    await createService(user2.token, { name: 'B-Only-1', duration_min: 40, price: 20 })

    const listA = await request(app)
      .get('/api/services')
      .set('Authorization', `Bearer ${user1.token}`)
    expect(listA.status).toBe(200)
    const namesA = listA.body.map(s => s.name)
    expect(namesA).toEqual(expect.arrayContaining(['A-Only-1', 'A-Only-2']))
    expect(namesA).not.toContain('B-Only-1')

    const listB = await request(app)
      .get('/api/services')
      .set('Authorization', `Bearer ${user2.token}`)
    expect(listB.status).toBe(200)
    const namesB = listB.body.map(s => s.name)
    expect(namesB).toEqual(expect.arrayContaining(['B-Only-1']))
    expect(namesB).not.toEqual(expect.arrayContaining(['A-Only-1', 'A-Only-2']))
  })
})
