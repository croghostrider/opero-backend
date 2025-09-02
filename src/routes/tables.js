const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const { requireFeature } = require('../middleware/subscription')

// ADMIN: Tische auflisten
router.get('/', requireFeature('self_ordering'), async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id, name, room, qr_token, is_active, created_at FROM tables ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// ADMIN: Tisch anlegen (+ Token)
router.post('/', requireFeature('self_ordering'), async (req, res, next) => {
  const { name, room } = req.body
  const token = crypto.randomBytes(6).toString('base64url') // ~8-9 chars
  try {
    const { rows } = await req.db.query(
      `INSERT INTO tables (tenant_id, name, room, qr_token)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3)
       RETURNING id, name, room, qr_token, is_active, created_at`,
      [name, room ?? null, token]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})

module.exports = router
