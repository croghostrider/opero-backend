'use strict'

const express = require('express')
const jwt = require('jsonwebtoken')
const router = express.Router()

const { makeProvider } = require('./providers/factory')
const { subscribe, broadcast } = require('./sseHub')
const crypto = require('crypto')

// Optional: Feature-Gating (falls vorhanden)
let requireFeature = (_f) => (req, _res, next) => next()
try { ({ requireFeature } = require('../middleware/subscription')) } catch {}

/* utils */
function isNumberLike (v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) }
function nowIso () { return new Date().toISOString() }
function rid (prefix = 'cash') { return `${prefix}_${crypto.randomBytes(6).toString('hex')}` }

/**
 * SSE-Stream für Live-Status von Zahlungen.
 * Erwartet ?token=<JWT> (gleiches JWT wie bei API-Auth).
 * Diese Route kann VOR der normalen Auth-Kette laufen.
 */
router.get('/stream', async (req, res) => {
  const token = String(req.query.token || '')
  if (!token) return res.status(401).end()

  let payload = null
  try { payload = jwt.decode(token) } catch { return res.status(401).end() }
  const tenantId = payload?.tenant_id || payload?.tenantId
  if (!tenantId) return res.status(401).end()

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write(': connected\n\n')

  subscribe(tenantId, res)
  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25000)
  req.on('close', () => clearInterval(ping))
})

/**
 * POST /api/pos/cash/charge
 * { amount, currency='CHF', tendered, note?, receipt_ref?, metadata? }
 * -> legt Payment (provider='cash') an, erzeugt Events, broadcastet und gibt Rückgeld zurück
 */
router.post('/cash/charge', requireFeature('pos'), async (req, res, next) => {
  try {
    const { amount, currency = 'CHF', tendered, note, receipt_ref, metadata } = req.body || {}
    if (!isNumberLike(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'amount > 0 required' })

    const amt = Number(amount)
    const tender = tendered == null ? amt : Number(tendered)
    if (!isNumberLike(tender) || tender < amt) {
      return res.status(400).json({ error: 'tendered must be >= amount' })
    }
    const change = +(tender - amt).toFixed(2)

    // Payment anlegen
    const pQ = await req.db.query(
      `INSERT INTO payments (tenant_id, provider, amount, currency, status, external_id, receipt_ref)
       VALUES (current_setting('app.tenant_id')::uuid, 'cash', $1, $2, 'approved', $3, $4)
       RETURNING id, provider, amount, currency, status, external_id, receipt_ref, created_at`,
      [amt, currency, rid('cash'), receipt_ref || null]
    )
    const payment = pQ.rows[0]

    // Events: approved + cash_details
    await req.db.query(
      `INSERT INTO payment_events (payment_id, type, payload)
       VALUES ($1,'approved', jsonb_build_object(
         'at', $2::timestamptz,
         'method', 'cash',
         'tendered', $3::numeric,
         'change', $4::numeric,
         'note', $5::text,
         'metadata', COALESCE($6::jsonb, '{}'::jsonb)
       ))`,
      [payment.id, nowIso(), tender, change, note || null, metadata ? JSON.stringify(metadata) : null]
    )

    // Broadcast
    broadcast(req.user?.tenantId, {
      payment_id: payment.id,
      type: 'approved',
      data: { method: 'cash', change, tendered: tender }
    })

    return res.status(201).json({
      ...payment,
      change,
      tendered: tender
    })
  } catch (e) { next(e) }
})

/**
 * POST /api/pos/terminal/charge
 * { amount, currency='CHF', provider? ('sumup'|'wallee'|...), terminal_id?, metadata? }
 * -> startet Terminalzahlung beim aktiven/konkreten Provider. Status= in_progress
 */
router.post('/terminal/charge', requireFeature('pos'), async (req, res, next) => {
  try {
    const { amount, currency = 'CHF', provider, terminal_id, metadata } = req.body || {}
    if (!isNumberLike(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'amount > 0 required' })

    // Provider-Konfiguration laden (konkret ODER active=true)
    const params = provider ? [provider] : []
    const cfgQ = await req.db.query(
      `SELECT provider, config
         FROM payment_providers
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND (${provider ? 'provider = $1' : 'active = true'})
        ORDER BY active DESC
        LIMIT 1`,
      params
    )
    if (!cfgQ.rowCount) return res.status(400).json({ error: 'No payment provider configured' })
    const { provider: prov, config } = cfgQ.rows[0]

    // Payment anlegen
    const pQ = await req.db.query(
      `INSERT INTO payments (tenant_id, provider, terminal_id, amount, currency, status)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, 'in_progress')
       RETURNING id`,
      [prov, terminal_id || null, Number(amount), currency]
    )
    const paymentId = pQ.rows[0].id

    // Provider starten (Adapter ist bei dir bereits vorhanden)
    const adapter = makeProvider(prov, config || {}, req.user?.tenantId)
    const result = await adapter.startPayment({
      amount: Number(amount),
      currency,
      terminal_id: terminal_id || null,
      metadata: metadata || {},
      paymentId
    })
    const externalId = result?.externalId || rid(prov)

    // Update + Event
    await req.db.query(
      'UPDATE payments SET external_id = $1 WHERE id = $2',
      [externalId, paymentId]
    )
    await req.db.query(
      `INSERT INTO payment_events (payment_id, type, payload)
       VALUES ($1, 'created', jsonb_build_object(
         'at', $2::timestamptz,
         'provider', $3::text,
         'external_id', $4::text,
         'step', $5::text,
         'meta', COALESCE($6::jsonb, '{}'::jsonb)
       ))`,
      [paymentId, nowIso(), prov, externalId, result?.step || 'awaiting_card', metadata ? JSON.stringify(metadata) : null]
    )

    broadcast(req.user?.tenantId, {
      payment_id: paymentId,
      type: 'created',
      data: { provider: prov, external_id: externalId, step: result?.step || 'awaiting_card' }
    })

    return res.status(201).json({
      id: paymentId,
      provider: prov,
      status: 'in_progress',
      external_id: externalId,
      step: result?.step || 'awaiting_card'
    })
  } catch (e) { next(e) }
})

/**
 * GET /api/pos/payments/:id
 * -> Payment inkl. letzter Events
 */
router.get('/payments/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const p = await req.db.query(
      `SELECT id, provider, terminal_id, amount, currency, status, external_id, receipt_ref, created_at
         FROM payments
        WHERE id = $1`,
      [id]
    )
    if (!p.rowCount) return res.status(404).json({ error: 'not found' })

    const ev = await req.db.query(
      `SELECT id, type, payload, created_at
         FROM payment_events
        WHERE payment_id = $1
        ORDER BY created_at DESC
        LIMIT 20`,
      [id]
    )

    res.json({ ...p.rows[0], events: ev.rows })
  } catch (e) { next(e) }
})

/**
 * POST /api/pos/payments/:payment_id/cancel
 * -> Terminalzahlung abbrechen (cash macht keinen Sinn)
 */
router.post('/payments/:payment_id/cancel', requireFeature('pos'), async (req, res, next) => {
  try {
    const { payment_id } = req.params

    const q = await req.db.query(
      `SELECT provider, external_id, status
         FROM payments
        WHERE id = $1`,
      [payment_id]
    )
    if (!q.rowCount) return res.status(404).json({ error: 'not found' })
    const { provider, external_id, status } = q.rows[0]
    if (provider === 'cash') return res.status(400).json({ error: 'cannot cancel cash payment' })
    if (status !== 'in_progress') return res.status(400).json({ error: 'only in_progress can be cancelled' })

    const cfg = await req.db.query(
      `SELECT config FROM payment_providers
        WHERE tenant_id = current_setting('app.tenant_id')::uuid AND provider = $1`,
      [provider]
    )
    const adapter = makeProvider(provider, cfg.rows[0]?.config || {}, req.user?.tenantId)
    await adapter.cancelPayment(external_id)

    await req.db.query('UPDATE payments SET status = \'cancelled\' WHERE id = $1', [payment_id])
    await req.db.query(
      `INSERT INTO payment_events (payment_id, type, payload)
       VALUES ($1, 'cancelled', jsonb_build_object('at',$2::timestamptz))`,
      [payment_id, nowIso()]
    )

    broadcast(req.user?.tenantId, { payment_id, type: 'cancelled' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * POST /api/pos/webhooks/:provider
 * -> Provider-Callback (z. B. Cloud-Events). Du kannst hier Signaturprüfung einbauen.
 * Erwartetes Payload (vereinheitlicht):
 * { external_id, status: 'approved'|'declined'|'error'|'in_progress', more? }
 */
router.post('/webhooks/:provider', async (req, res, next) => {
  try {
    const { provider } = req.params
    const body = req.body || {}
    const { external_id, status } = body
    if (!external_id) return res.status(400).json({ error: 'external_id required' })
    if (!status) return res.status(400).json({ error: 'status required' })

    // Payment per external_id finden (tenant-safe dank RLS)
    const p = await req.db.query(
      'SELECT id FROM payments WHERE external_id = $1',
      [external_id]
    )
    if (!p.rowCount) return res.status(404).json({ error: 'payment not found' })
    const id = p.rows[0].id

    // Status übernehmen
    await req.db.query(
      'UPDATE payments SET status = $2 WHERE id = $1',
      [id, status]
    )
    await req.db.query(
      `INSERT INTO payment_events (payment_id, type, payload)
       VALUES ($1, 'status', $2::jsonb)`,
      [id, JSON.stringify({ provider, external_id, status, at: nowIso(), raw: body })]
    )

    broadcast(req.user?.tenantId, {
      payment_id: id,
      type: 'status',
      data: { status, provider, external_id }
    })

    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
