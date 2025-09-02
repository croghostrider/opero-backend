const Base = require('./_base')
class Worldline extends Base {
  async startPayment (ctx) {
    // TODO: EP2/OPI/NEXO call via gateway
    return { externalId: `wl_${ctx.paymentId}`, status: 'in_progress', step: 'awaiting_card' }
  }
}
module.exports = Worldline
