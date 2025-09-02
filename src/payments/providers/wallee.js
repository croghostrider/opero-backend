const Base = require('./_base')
class Wallee extends Base {
  async startPayment (ctx) {
    // TODO: Wallee REST: Transaction + Terminal Payment Initiation
    return { externalId: `wal_${ctx.paymentId}`, status: 'in_progress', step: 'awaiting_card' }
  }
}
module.exports = Wallee
