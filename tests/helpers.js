/* eslint-env jest */
const request = require('supertest')
const app = require('../src/app')

/**
 * Erstellt einen neuen User und liefert Token + Login-Daten zurück.
 * Optionaler Tag macht die E-Mail noch leichter unterscheidbar.
 */
async function signupAndGetToken (tag = '') {
  const email = `test${tag ? '+' + tag : ''}+${Date.now()}@opero.dev`
  const password = 'demo1234'
  const res = await request(app).post('/api/auth/signup').send({ email, password })
  expect(res.status).toBe(201)
  expect(res.body.token).toBeTruthy()
  return { token: res.body.token, email, password }
}

/** Erzeugt zwei verschiedene User und gibt beide Tokens zurück. */
async function signupTwoUsers () {
  const u1 = await signupAndGetToken('u1')
  // kleine Verzögerung vermeidet Kollisionen mit Date.now() (theoretisch)
  await new Promise(r => setTimeout(r, 5))
  const u2 = await signupAndGetToken('u2')
  return { user1: u1, user2: u2 }
}

/** Erzeugt einen Supertest-Request mit Authorization-Header. */
function authRequest (token) {
  return request(app).set('Authorization', `Bearer ${token}`)
}

/** Hilfsfunktion: Produkt anlegen (für den eingeloggten User/Mandanten). */
async function createProduct (token, { name, price, vat_rate } = {}) {
  const payload = {
    name: name ?? `Prod ${Date.now()}`,
    kind: 'goods',
    price: price ?? 1.0,
    vat_rate: vat_rate ?? 2.5
  }
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
  expect(res.status).toBe(201)
  return res.body // { id, name, price, vat_rate, created_at }
}

async function createEmployee (token, payload = {}) {
  const body = {
    display_name: 'Emp-' + Math.random().toString(36).slice(2, 8),
    ...payload
  }

  const res = await request(app)
    .post('/api/employees')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

  if (res.status !== 201) {
    // Für Debug bei Fehlschlag:
    // eslint-disable-next-line no-console
    console.error('createEmployee failed:', res.status, res.body)
  }
  expect(res.status).toBe(201)
  return res.body // { id, display_name, ... }
}

// Falls noch nicht vorhanden, gleich auch den Service-Helper:
async function createService (token, payload = {}) {
  const body = {
    name: 'Service-' + Math.random().toString(36).slice(2, 8),
    duration_min: 30,
    price: 10,
    ...payload
  }

  const res = await request(app)
    .post('/api/services')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

  if (res.status !== 201) {
    // eslint-disable-next-line no-console
    console.error('createService failed:', res.status, res.body)
  }
  expect(res.status).toBe(201)
  return res.body // { id, name, ... }
}

module.exports = {
  app,
  request,
  signupAndGetToken,
  signupTwoUsers,
  authRequest,
  createProduct,
  createEmployee,
  createService
}
