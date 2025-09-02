'use strict'

/**
 * Per-Request PG-Client + RLS-Tenant-Context via set_config('app.tenant_id', $1, true)
 * Nutzung: app.use(auth), dann app.use(tenantContext(pool)) ODER app.use(tenantContext())
 */
module.exports = function tenantContext (providedPool) {
  return async function tenantContextMiddleware (req, res, next) {
    // Pool bevorzugt aus Parameter, sonst aus app.get('pool')
    const pool = providedPool || req.app?.get('pool')
    if (!pool) return res.status(500).json({ error: 'DB pool missing' })

    // tenant_id aus Auth-Stack holen
    const tenantId =
      req.user?.tenant_id ??
      req.auth?.tenant_id ??
      req.tenantId // optionaler Fallback, falls du ihn woanders setzt

    // Validierung: vorhanden + UUID
    if (!tenantId) {
      return res.status(401).json({ error: 'tenant_id missing in auth context' })
    }
    const tid = String(tenantId)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tid)
    if (!isUuid) {
      return res.status(400).json({ error: 'tenant_id must be a UUID' })
    }

    const client = await pool.connect()
    let finished = false

    const finish = async (ok) => {
      if (finished) return
      finished = true
      try {
        if (ok) await client.query('COMMIT')
        else await client.query('ROLLBACK')
      } catch {
        /* noop */
      } finally {
        client.release()
      }
    }

    // Bei jeder Antwort sauber abschließen
    res.on('finish', () => finish(true))
    res.on('close', () => finish(false))
    res.on('error', () => finish(false))

    try {
      await client.query('BEGIN')
      // RLS: nur per SET LOCAL/ set_config (3. Param = true) setzen
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tid])

      // Downstream-Handler nutzen denselben Client
      req.db = client
      return next()
    } catch (e) {
      await finish(false)
      return next(e)
    }
  }
}
