'use strict'
const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const router = express.Router()

// Helper zum Token bauen
function signToken ({ userId, email, tenantId }) {
  return jwt.sign(
    { sub: userId, email, tenant_id: tenantId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

// POST /auth/signup
router.post('/signup', async (req, res, next) => {
  /*
    #swagger.tags = ['Auth']
    #swagger.summary = 'Signup'
    #swagger.description = 'Erstellt einen neuen Benutzer, legt einen Tenant an und liefert ein JWT zurück.'
    #swagger.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email:    { type: 'string', format: 'email', example: 'demo@opero.ch' },
              password: { type: 'string', minLength: 6, example: 'secret123' }
            }
          }
        }
      }
    }
    #swagger.responses[201] = {
      description: 'User erstellt',
      content: {
        "application/json": {
          schema: {
            type: 'object',
            properties: { token: { type: 'string', example: 'jwt.token.here' } }
          }
        }
      }
    }
    #swagger.responses[400] = {
      description: 'Bad Request (email/password fehlen oder ungültig)',
      content: { "application/json": { schema: { $ref: '#/components/schemas/Error' } } }
    }
    #swagger.responses[409] = {
      description: 'Conflict (E-Mail bereits registriert)',
      content: { "application/json": { schema: { $ref: '#/components/schemas/Error' } } }
    }
    #swagger.responses[500] = { description: 'Internal Server Error' }
  */
  const pool = req.app.get('pool') // ✅ gleicher Pool wie in app.js
  if (!pool) return res.status(500).json({ error: 'DB pool not initialized' })

  const { email, password } = req.body || {}
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const exists = await client.query('SELECT 1 FROM users WHERE email=$1', [email])
    if (exists.rowCount) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'email already registered' })
    }

    // Tenant anlegen (simple: nutze Teil vor @ als Name)
    const tenantName = email.split('@')[0]
    const t = await client.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [tenantName]
    )
    const tenantId = t.rows[0].id

    const hash = await bcrypt.hash(password, 10)
    const u = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1,$2,$3,'owner')
       RETURNING id`,
      [tenantId, email, hash]
    )
    const userId = u.rows[0].id

    await client.query('COMMIT')

    const token = signToken({ userId, email, tenantId })
    return res.status(201).json({ token })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    next(e)
  } finally {
    client.release()
  }
})

// POST /auth/login
router.post('/login', async (req, res, next) => {
  /*
    #swagger.tags = ['Auth']
    #swagger.summary = 'Login'
    #swagger.description = 'Prüft Zugangsdaten und liefert bei Erfolg ein JWT zurück.'
    #swagger.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email:    { type: 'string', format: 'email', example: 'demo@opero.ch' },
              password: { type: 'string', example: 'secret123' }
            }
          }
        }
      }
    }
    #swagger.responses[200] = {
      description: 'JWT zurückgegeben',
      content: {
        "application/json": {
          schema: {
            type: 'object',
            properties: { token: { type: 'string', example: 'jwt.token.here' } }
          }
        }
      }
    }
    #swagger.responses[400] = {
      description: 'Bad Request (email/password fehlen)',
      content: { "application/json": { schema: { $ref: '#/components/schemas/Error' } } }
    }
    #swagger.responses[401] = {
      description: 'Unauthorized (ungültige Credentials)',
      content: { "application/json": { schema: { $ref: '#/components/schemas/Error' } } }
    }
    #swagger.responses[500] = { description: 'Internal Server Error' }
  */
  const pool = req.app.get('pool')
  if (!pool) return res.status(500).json({ error: 'DB pool not initialized' })

  const { email, password } = req.body || {}
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' })
  }

  try {
    const r = await pool.query(
      'SELECT id, tenant_id, password_hash FROM users WHERE email=$1 LIMIT 1',
      [email]
    )
    if (!r.rowCount) return res.status(401).json({ error: 'invalid credentials' })

    const ok = await bcrypt.compare(password, r.rows[0].password_hash)
    if (!ok) return res.status(401).json({ error: 'invalid credentials' })

    const token = signToken({
      userId: r.rows[0].id,
      email,
      tenantId: r.rows[0].tenant_id
    })
    return res.json({ token })
  } catch (e) {
    next(e)
  }
})

router.get('/whoami', (req, res) => {
  /*
    #swagger.tags = ['Auth']
    #swagger.summary = 'Who am I'
    #swagger.description = 'Gibt das aktuell authentifizierte User-Objekt zurück.'
    #swagger.responses[200] = {
      description: 'User-Informationen (oder null, falls Gast – abhängig von Middleware-Konfiguration)',
      content: {
        "application/json": {
          schema: {
            type: 'object',
            properties: {
              user: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      id:        { type: 'string', format: 'uuid', example: 'b2a0c0d0-1234-4567-89ab-0c0d0e0f1234' },
                      email:     { type: 'string', format: 'email', example: 'demo@opero.ch' },
                      tenant_id: { type: 'string', format: 'uuid', example: '4f8d8f44-aaaa-bbbb-cccc-ddddeeeeffff' },
                      role:      { type: 'string', example: 'owner' }
                    }
                  },
                  { type: 'null' }
                ]
              }
            }
          }
        }
      }
    }
    #swagger.responses[401] = {
      description: 'Unauthorized (fehlendes/ungültiges JWT – falls Middleware so konfiguriert)',
      content: { "application/json": { schema: { $ref: '#/components/schemas/Error' } } }
    }
  */
  // Diese Route bitte NACH auth-Middleware mounten, z. B.:
  // app.use(auth); app.use('/auth', authRouterProtected);
  res.json({ user: req.user || null })
})

module.exports = router
