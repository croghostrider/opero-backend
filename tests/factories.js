const { pool } = require('./setupTestDB')
async function createTenant (client, name = 't' + Date.now()) {
  const r = await client.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [name])
  return r.rows[0]
}
async function createUser (client, tenant_id, email = 'u' + Date.now() + '@t.dev', role = 'owner') {
  const r = await client.query(
    'INSERT INTO users(tenant_id,email,password_hash,role) VALUES ($1,$2,\'x\', $3) RETURNING id,email,tenant_id',
    [tenant_id, email, role]
  )
  return r.rows[0]
}
module.exports = { createTenant, createUser }
