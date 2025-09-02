'use strict'

const router = require('./router')

module.exports = {
  mount (app) {
    // Stelle sicher, dass HINTER auth + tenantContext gemountet wird,
    // damit current_setting('app.tenant_id') gesetzt ist.
    app.use('/api/pos', router)
  }
}
