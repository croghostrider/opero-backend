const express = require('express')
const router = express.Router()

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id, total, created_at FROM orders ORDER BY created_at DESC'
    )
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  const { total } = req.body
  try {
    const { rows } = await req.db.query(
      `INSERT INTO orders (tenant_id, total)
       VALUES (current_setting('app.tenant_id')::uuid, $1)
       RETURNING id, total, created_at`,
      [total]
    )
    res.status(201).json(rows[0])
  } catch (e) { next(e) }
})
module.exports = router
