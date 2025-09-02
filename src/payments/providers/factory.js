// payments/providers/factory.js
const SumUp = require('./sumup')
const Wallee = require('./wallee')
const Worldline = require('./worldline')
const Nexi = require('./nexi')
const PayTec = require('./paytec')

function makeProvider (provider, config, tenantId) {
  switch (provider) {
    case 'sumup': return new SumUp(config, tenantId)
    case 'wallee': return new Wallee(config, tenantId)
    case 'worldline': return new Worldline(config, tenantId)
    case 'nexi': return new Nexi(config, tenantId)
    case 'paytec': return new PayTec(config, tenantId)
    default: throw new Error('Unsupported provider')
  }
}
module.exports = { makeProvider }
