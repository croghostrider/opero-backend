const Base = require('./_base')
class Nexi extends Base {
  async startPayment (ctx) {
    // TODO: Nexi Cloud Terminal API
    return { externalId: `nexi_${ctx.paymentId}`, status: 'in_progress', step: 'awaiting_card' }
  }
}
module.exports = Nexi
