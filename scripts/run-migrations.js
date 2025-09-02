const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })

const connStr = process.env.ADMIN_DATABASE_URL
if (!connStr) {
  console.error('❌ ADMIN_DATABASE_URL missing in .env')
  process.exit(1)
}

(async () => {
  const client = new Client({ connectionString: connStr })
  await client.connect()

  const dir = path.join(__dirname, '..', 'migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    console.log(`▶️ Running migration: ${file}`)
    await client.query(sql)
    console.log(`✅ Done: ${file}`)
  }

  await client.end()
})()
