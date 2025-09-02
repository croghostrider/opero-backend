const Base = require('./_base')
class PayTec extends Base {
  async startPayment (ctx) {
    // TODO: PayTec local/EP2 integration
    return { externalId: `pt_${ctx.paymentId}`, status: 'in_progress', step: 'awaiting_card' }
  }
}
module.exports = PayTec
