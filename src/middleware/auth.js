// backend/src/middleware/auth.js
'use strict'
const jwt = require('jsonwebtoken')

module.exports = function auth (req, res, next) {
  // Preflights durchlassen
  if (req.method === 'OPTIONS') return res.sendStatus(204)

  const hdr = req.headers.authorization || ''
  if (!hdr.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = hdr.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    // Erwartet: payload.tenant_id existiert (kommt vom Signup/Login)
    req.user = payload
    return next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}
