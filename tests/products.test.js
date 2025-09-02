/* eslint-env jest */
const { request, app, signupAndGetToken, signupTwoUsers, createProduct } = require('./helpers')

describe('Products API (auth, CRUD & tenant isolation)', () => {
  let token
  const DEFAULT_KIND = 'goods' // oder 'food', falls du direkt Food anlegen willst

  beforeAll(async () => {
    ({ token } = await signupAndGetToken())
  })

  // --- Auth ---
  test('GET /api/products ohne Token → 401', async () => {
    const r = await request(app).get('/api/products')
    expect(r.status).toBe(401)
  })

  test('GET /api/products mit Token → 200 (Array)', async () => {
    const r = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  // --- CRUD-Flow ---
  test('create → list → update → delete', async () => {
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Espresso', kind: DEFAULT_KIND, price: 3.5, vat_rate: 2.5 })
    expect(created.status).toBe(201)
    const id = created.body.id

    const list = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.find(p => p.id === id)?.name).toBe('Espresso')

    const upd = await request(app)
      .put(`/api/products/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Espresso Doppio', price: 4.5 })
    expect(upd.status).toBe(200)
    expect(upd.body.name).toBe('Espresso Doppio')
    // numeric kommt von pg standardmäßig als String zurück
    expect(upd.body.price).toBe('4.50')

    const del = await request(app)
      .delete(`/api/products/${id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)

    const listAfter = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${token}`)
    expect(listAfter.body.find(p => p.id === id)).toBeUndefined()
  })

  // --- Validierungen ---
  test('POST ohne name → 400', async () => {
    const r = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: DEFAULT_KIND, price: 1 })
    expect(r.status).toBe(400)
    expect(String(r.body.error || '')).toMatch(/name/i)
  })

  test('PUT mit ungültigem price → 400', async () => {
    const created = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'InvalidTest', kind: DEFAULT_KIND, price: 1 })
    const id = created.body.id

    const upd = await request(app)
      .put(`/api/products/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: -5 })
    expect(upd.status).toBe(400)
    expect(String(upd.body.error || '')).toMatch(/price/i)
  })

  test('DELETE unbekannte ID → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const r = await request(app)
      .delete(`/api/products/${fakeId}`) // Fix: /api/products statt /products
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(404)
  })

  // --- Tenant-Isolation / Mandantentrennung ---
  test('User A sieht nur A-Produkte, User B sieht nur B-Produkte', async () => {
    const { user1, user2 } = await signupTwoUsers()
    // A legt 2 Produkte an
    const a1 = await createProduct(user1.token, { name: 'A-Only-1', kind: DEFAULT_KIND, price: 10 })
    const a2 = await createProduct(user1.token, { name: 'A-Only-2', kind: DEFAULT_KIND, price: 11 })
    // B legt 1 Produkt an
    const b1 = await createProduct(user2.token, { name: 'B-Only-1', kind: DEFAULT_KIND, price: 20 })

    // Listen mit Token A → nur A-Produkte erwarten
    const listA = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${user1.token}`)
    expect(listA.status).toBe(200)
    const namesA = listA.body.map(p => p.name)
    expect(namesA).toEqual(expect.arrayContaining(['A-Only-1', 'A-Only-2']))
    expect(namesA).not.toContain('B-Only-1')

    // Listen mit Token B → nur B-Produkte erwarten
    const listB = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${user2.token}`)
    expect(listB.status).toBe(200)
    const namesB = listB.body.map(p => p.name)
    expect(namesB).toEqual(expect.arrayContaining(['B-Only-1']))
    expect(namesB).not.toContain('A-Only-1')
    expect(namesB).not.toContain('A-Only-2')
  })
})
