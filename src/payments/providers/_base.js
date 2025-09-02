class TerminalProviderBase {
  constructor (config, tenantId) { this.config = config || {}; this.tenantId = tenantId }
  async startPayment ({ amount, currency, terminal_id, metadata, paymentId }) {
    // Implement in child
    return { externalId: `mock_${paymentId}`, status: 'in_progress', step: 'awaiting_card' }
  }

  async cancelPayment (externalId) { return { ok: true } }
  async fetchStatus (externalId) { return { status: 'in_progress' } }
}
module.exports = TerminalProviderBase
