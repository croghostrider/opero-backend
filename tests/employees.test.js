/* eslint-env jest */
const {
  request, app,
  signupAndGetToken, signupTwoUsers,
  createEmployee, createService
} = require('./helpers')

describe('Employees API (CRUD, skills, availability, time-off & isolation)', () => {
  let token
  beforeAll(async () => {
    ({ token } = await signupAndGetToken())
  })

  // --- Auth ---
  test('GET /api/employees ohne Token → 401', async () => {
    const r = await request(app).get('/api/employees')
    expect(r.status).toBe(401)
  })

  test('GET /api/employees mit Token → 200 (Array)', async () => {
    const r = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  // --- CRUD-Flow ---
  test('create → list → update → delete', async () => {
    const created = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ display_name: 'Selina', email: 'selina@example.com' })
    expect(created.status).toBe(201)
    const id = created.body.id

    const list = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.find(e => e.id === id)?.display_name).toBe('Selina')

    const upd = await request(app)
      .put(`/api/employees/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: false, phone: '+41000000' })
    expect(upd.status).toBe(200)
    expect(upd.body.is_active).toBe(false)
    expect(upd.body.phone).toBe('+41000000')

    const del = await request(app)
      .delete(`/api/employees/${id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)

    const listAfter = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${token}`)
    expect(listAfter.body.find(e => e.id === id)).toBeUndefined()
  })

  // --- Validierungen ---
  test('POST ohne display_name → 400', async () => {
    const r = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'x@y.z' })
    expect(r.status).toBe(400)
    expect(String(r.body.error || '')).toMatch(/display_name/i)
  })

  test('DELETE unbekannte ID → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const r = await request(app)
      .delete(`/api/employees/${fakeId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(404)
  })

  // --- Tenant-Isolation ---
  test('User A sieht nur A-Employees, User B nur B-Employees', async () => {
    const { user1, user2 } = await signupTwoUsers()
    await createEmployee(user1.token, { display_name: 'A-Only-1' })
    await createEmployee(user1.token, { display_name: 'A-Only-2' })
    await createEmployee(user2.token, { display_name: 'B-Only-1' })

    const listA = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${user1.token}`)
    expect(listA.status).toBe(200)
    const namesA = listA.body.map(e => e.display_name)
    expect(namesA).toEqual(expect.arrayContaining(['A-Only-1', 'A-Only-2']))
    expect(namesA).not.toContain('B-Only-1')

    const listB = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${user2.token}`)
    expect(listB.status).toBe(200)
    const namesB = listB.body.map(e => e.display_name)
    expect(namesB).toEqual(expect.arrayContaining(['B-Only-1']))
    expect(namesB).not.toEqual(expect.arrayContaining(['A-Only-1', 'A-Only-2']))
  })

  // --- Skills (employee_services) ---
  test('Service zuweisen, auflisten, bulk ersetzen & entfernen', async () => {
    const emp = await createEmployee(token, { display_name: 'Max' })
    const s1 = await createService(token, { name: 'Cut', duration_min: 30, price: 29 })
    const s2 = await createService(token, { name: 'Color', duration_min: 60, price: 59 })

    // assign s1
    const link1 = await request(app)
      .post(`/api/employees/${emp.id}/services`)
      .set('Authorization', `Bearer ${token}`)
      .send({ service_id: s1.id })
    expect(link1.status).toBe(201)

    // duplicate assign → 400
    const dup = await request(app)
      .post(`/api/employees/${emp.id}/services`)
      .set('Authorization', `Bearer ${token}`)
      .send({ service_id: s1.id })
    expect(dup.status).toBe(400)

    // list
    const list1 = await request(app)
      .get(`/api/employees/${emp.id}/services`)
      .set('Authorization', `Bearer ${token}`)
    expect(list1.status).toBe(200)
    expect(list1.body.map(x => x.service_id)).toEqual(expect.arrayContaining([s1.id]))

    // bulk replace with [s2]
    const bulk = await request(app)
      .put(`/api/employees/${emp.id}/services/bulk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ service_ids: [s2.id] })
    expect(bulk.status).toBe(200)
    expect(bulk.body.map(x => x.service_id)).toEqual([s2.id])

    // unassign
    const linkId = bulk.body[0].id
    const del = await request(app)
      .delete(`/api/employees/${emp.id}/services/${linkId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)
  })

  test('Service eines anderen Tenants zuweisen → 400', async () => {
    const { user1, user2 } = await signupTwoUsers()
    const empA = await createEmployee(user1.token, { display_name: 'EmpA' })
    const svcB = await createService(user2.token, { name: 'SvcB', duration_min: 10, price: 5 })

    const r = await request(app)
      .post(`/api/employees/${empA.id}/services`)
      .set('Authorization', `Bearer ${user1.token}`)
      .send({ service_id: svcB.id }) // gehört Tenant B
    expect(r.status).toBe(400) // Trigger/tenant mismatch
  })

  // --- Availability ---
  test('Availability anlegen, ändern, löschen', async () => {
    const emp = await createEmployee(token, { display_name: 'Laura' })

    const created = await request(app)
      .post(`/api/employees/${emp.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ weekday: 1, start_time: '09:00', end_time: '17:00', location: 'Salon' })
    expect(created.status).toBe(201)
    const availId = created.body.id

    const list = await request(app)
      .get(`/api/employees/${emp.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.find(a => a.id === availId)?.weekday).toBe(1)

    const upd = await request(app)
      .put(`/api/employees/${emp.id}/availability/${availId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ end_time: '18:00' })
    expect(upd.status).toBe(200)
    expect(upd.body.end_time).toBe('18:00:00') // PG gibt time als HH:MM:SS

    const del = await request(app)
      .delete(`/api/employees/${emp.id}/availability/${availId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)
  })

  test('Availability mit ungültigem weekday → 400', async () => {
    const emp = await createEmployee(token, { display_name: 'Jon' })
    const r = await request(app)
      .post(`/api/employees/${emp.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ weekday: 9, start_time: '10:00', end_time: '11:00' })
    expect(r.status).toBe(400)
  })

  // --- Time-Off ---
  test('Time-off anlegen, ändern, löschen', async () => {
    const emp = await createEmployee(token, { display_name: 'Mira' })

    const created = await request(app)
      .post(`/api/employees/${emp.id}/time-off`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        starts_at: '2025-09-15T12:00:00+02:00',
        ends_at: '2025-09-15T14:00:00+02:00',
        reason: 'Arzt'
      })
    expect(created.status).toBe(201)
    const tid = created.body.id

    const list = await request(app)
      .get(`/api/employees/${emp.id}/time-off`)
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.find(t => t.id === tid)).toBeTruthy()

    const upd = await request(app)
      .put(`/api/employees/${emp.id}/time-off/${tid}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Urlaub' })
    expect(upd.status).toBe(200)
    expect(upd.body.reason).toBe('Urlaub')

    const del = await request(app)
      .delete(`/api/employees/${emp.id}/time-off/${tid}`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)
  })

  test('Time-off ohne starts_at/ends_at → 400', async () => {
    const emp = await createEmployee(token, { display_name: 'Noah' })
    const r = await request(app)
      .post(`/api/employees/${emp.id}/time-off`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'x' })
    expect(r.status).toBe(400)
  })
})
