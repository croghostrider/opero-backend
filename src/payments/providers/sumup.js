const Base = require('./_base')
class SumUp extends Base {
  async startPayment (ctx) {
    // TODO: SumUp API/SDK call; hier Mock
    return { externalId: `sumup_${ctx.paymentId}`, status: 'in_progress', step: 'awaiting_card' }
  }
}
module.exports = SumUp
