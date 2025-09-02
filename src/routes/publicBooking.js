'use strict'

const express = require('express')
const router = express.Router()

/**
 * Diese Public-Endpoints erwarten, dass VORHER ein Tenant-Kontext gesetzt wurde
 * (z. B. via publicTenantContext(pool, { from: 'menu' | 'table' | 'booking' }))
 * und req.db existiert. Falls nicht, geben wir eine klare Fehlermeldung aus.
 */

function assertTenantContext (req, res) {
  if (!req.db) {
    res.status(500).json({
      error:
        'Tenant context not set. Mount this router behind publicTenantContext(...) so app.tenant_id is set.'
    })
    return false
  }
  return true
}

/**
 * GET /public/booking/availability
 * Query: from, to (ISO), service_id (optional), staff_id (optional)
 * Liefert freie Slots im 30-Minuten-Raster (bzw. Service-Dauer).
 */
router.get('/availability', async (req, res, next) => {
  if (!assertTenantContext(req, res)) return
  const { from, to, service_id, staff_id } = req.query || {}

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to (ISO strings) are required' })
  }

  try {
    // Dauer bestimmen
    let duration = 30
    if (service_id) {
      const s = await req.db.query(
        'SELECT duration_min FROM services WHERE id = $1',
        [service_id]
      )
      if (s.rowCount) duration = Number(s.rows[0].duration_min) || 30
    }

    // Mitarbeitende bestimmen
    const staff = staff_id
      ? (
          await req.db.query(
            'SELECT id, name FROM staff WHERE id = $1 AND active = true',
            [staff_id]
          )
        ).rows
      : (
          await req.db.query(
            'SELECT id, name FROM staff WHERE active = true ORDER BY name'
          )
        ).rows

    // Bereits belegte Zeiten
    const busy = (
      await req.db.query(
        `SELECT staff_id, start_at, end_at
           FROM bookings
          WHERE start_at >= $1 AND start_at < $2
            AND status <> 'cancelled'`,
        [from, to]
      )
    ).rows

    // Regeln laden
    const rules = (await req.db.query('SELECT * FROM availability_rules')).rows

    // Slots generieren
    const out = []
    const start = new Date(from)
    const end = new Date(to)

    for (const st of staff) {
      let t = new Date(start)
      while (t < end) {
        const slotStart = new Date(t)
        const slotEnd = new Date(slotStart.getTime() + duration * 60000)
        const wd = slotStart.getDay()
        const dayISO = slotStart.toISOString().slice(0, 10)

        // innerhalb einer passenden Regel?
        const rs = rules.filter(
          (r) =>
            (!r.staff_id || r.staff_id === st.id) &&
            r.weekday === wd &&
            !(Array.isArray(r.exceptions) && r.exceptions.includes(dayISO))
        )

        const within = rs.some((r) => {
          // r.start_time/end_time im Format HH:MM:SS
          const [sh, sm] = String(r.start_time).split(':').map(Number)
          const [eh, em] = String(r.end_time).split(':').map(Number)

          const startOK =
            slotStart.getHours() > sh ||
            (slotStart.getHours() === sh && slotStart.getMinutes() >= sm)
          const endOK =
            slotEnd.getHours() < eh ||
            (slotEnd.getHours() === eh && slotEnd.getMinutes() <= em)
          return startOK && endOK
        })

        if (!within) {
          t = new Date(t.getTime() + 30 * 60000)
          continue
        }

        // Kollision?
        const collision = busy.some(
          (b) =>
            b.staff_id === st.id &&
            !(
              slotEnd <= new Date(b.start_at) || slotStart >= new Date(b.end_at)
            )
        )

        if (!collision) {
          out.push({
            staff_id: st.id,
            staff_name: st.name,
            start_at: slotStart.toISOString(),
            end_at: slotEnd.toISOString()
          })
        }

        t = new Date(t.getTime() + 30 * 60000)
      }
    }

    res.json(out)
  } catch (e) {
    next(e)
  }
})

/**
 * POST /public/booking
 * Body: { service_id, staff_id?, start_at, customer: { name, email, phone } }
 * Legt eine Buchung an (Status 'new') – sehr simpel; Validierung/Double-Opt-In kannst du nachziehen.
 */
router.post('/', async (req, res, next) => {
  if (!assertTenantContext(req, res)) return

  const { service_id, staff_id, start_at, customer } = req.body || {}
  if (!service_id || !start_at) {
    return res.status(400).json({ error: 'service_id and start_at are required' })
  }

  try {
    // Dauer bestimmen
    const s = await req.db.query(
      'SELECT duration_min FROM services WHERE id = $1',
      [service_id]
    )
    if (!s.rowCount) return res.status(400).json({ error: 'invalid service_id' })

    const dur = Number(s.rows[0].duration_min) || 30
    const end_at = new Date(new Date(start_at).getTime() + dur * 60000).toISOString()

    // Customer upsert (nach Email)
    let custId = null
    if (customer?.email) {
      const c1 = await req.db.query(
        'SELECT id FROM customers WHERE email = $1 LIMIT 1',
        [customer.email]
      )
      if (c1.rowCount) {
        custId = c1.rows[0].id
      } else {
        const c2 = await req.db.query(
          `INSERT INTO customers (tenant_id, name, email, phone)
           VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3)
           RETURNING id`,
          [customer.name || null, customer.email, customer.phone || null]
        )
        custId = c2.rows[0].id
      }
    }

    // Kollision
    const col = await req.db.query(
      `SELECT 1
         FROM bookings
        WHERE staff_id = $1
          AND status <> 'cancelled'
          AND NOT ($3 <= start_at OR $2 >= end_at)
        LIMIT 1`,
      [staff_id || null, start_at, end_at]
    )
    if (col.rowCount) return res.status(409).json({ error: 'slot already taken' })

    // Buchung anlegen
    const r = await req.db.query(
      `INSERT INTO bookings (tenant_id, service_id, customer_id, staff_id, start_at, end_at, source, status)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, 'public', 'new')
       RETURNING *`,
      [service_id, custId, staff_id || null, start_at, end_at]
    )

    res.status(201).json(r.rows[0])
  } catch (e) {
    next(e)
  }
})

module.exports = router
