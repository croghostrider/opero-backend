// Simple SSE Hub: pro Tenant eine Liste verbundener Clients
const clients = new Map() // tenantId -> Set(res)

function subscribe (tenantId, res) {
  if (!clients.has(tenantId)) clients.set(tenantId, new Set())
  const set = clients.get(tenantId)
  set.add(res)
  res.on('close', () => {
    set.delete(res)
    if (set.size === 0) clients.delete(tenantId)
  })
}

function broadcast (tenantId, event) {
  const set = clients.get(tenantId)
  if (!set) return
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of set) res.write(data)
}

module.exports = { subscribe, broadcast }
