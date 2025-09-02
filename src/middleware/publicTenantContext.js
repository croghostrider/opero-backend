'use strict'

/**
 * Public Tenant Context Middleware
 * Ermittelt tenant_id (z. B. über Menü-Slug) und setzt sie via set_config().
 */
module.exports = function publicTenantContext (pool, { from } = {}) {
  if (!pool) throw new Error('publicTenantContext requires a pg pool')
  if (!['menu', 'table', 'booking'].includes(from)) {
    throw new Error('publicTenantContext: option { from } must be "menu" | "table" | "booking"')
  }

  return async function (req, res, next) {
    const client = await pool.connect()
    let finished = false

    const finish = async (ok) => {
      if (finished) return
      finished = true
      try {
        if (ok) await client.query('COMMIT')
        else await client.query('ROLLBACK')
      } catch {}
      client.release()
    }

    res.on('finish', () => finish(true))
    res.on('close', () => finish(false))
    res.on('error', () => finish(false))

    try {
      await client.query('BEGIN')

      let tenantId = null

      if (from === 'menu' || from === 'booking') {
        const slug = req.params?.slug || req.query?.slug
        if (!slug) { await finish(false); return res.status(400).json({ error: 'Missing slug' }) }
        const r = await client.query(
          'SELECT tenant_id FROM menus WHERE slug=$1 AND is_public=true LIMIT 1',
          [slug]
        )
        if (!r.rowCount) { await finish(false); return res.status(404).json({ error: 'Not found' }) }
        tenantId = r.rows[0].tenant_id
      } else if (from === 'table') {
        const token = req.params?.token || req.query?.token || req.query?.t
        if (!token) { await finish(false); return res.status(400).json({ error: 'Missing table token' }) }
        const r = await client.query(
          'SELECT tenant_id FROM tables WHERE qr_token=$1 AND is_active=true LIMIT 1',
          [token]
        )
        if (!r.rowCount) { await finish(false); return res.status(404).json({ error: 'Not found' }) }
        tenantId = r.rows[0].tenant_id
      }

      // GUC setzen – Parameter via set_config
      await client.query('SELECT set_config(\'app.tenant_id\', $1, true)', [String(tenantId)])
      req.db = client
      next()
    } catch (e) {
      await finish(false)
      next(e)
    }
  }
}
