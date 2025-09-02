#!/usr/bin/env node
/* Generate DB docs from .env DATABASE_URL / TEST_DATABASE_URL
 * Steps:
 * 1) pg_dump (Docker) -> backend/docs/schema.sql
 * 2) SchemaSpy (Docker) -> backend/docs/db/index.html
 * 3) dbdocs build -> hosted docs (optional, requires login)
 * 4) dbdocs db2dbml -> backend/docs/database.dbml
 */
const path = require('path')
const fs = require('fs')
const { execSync, spawnSync } = require('child_process')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })

const args = process.argv.slice(2)
const isTest = args.includes('--target=test')
const noHosted = args.includes('--no-hosted') // skip dbdocs build
const steps = new Set(args.filter(a => a.startsWith('--only=')).map(a => a.split('=')[1].split(','))[0] || [])
// steps can contain: dump, schemaspy, dbdocs, dbml

const connUrl = isTest ? (process.env.TEST_DATABASE_URL || process.env.ADMIN_DATABASE_URL) : process.env.ADMIN_DATABASE_URL
if (!connUrl) {
  console.error('❌ No DATABASE_URL/TEST_DATABASE_URL found in .env')
  process.exit(1)
}

const outDir = path.resolve(__dirname, '..', 'docs')
const dbDocsDir = path.join(outDir, 'db')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
if (!fs.existsSync(dbDocsDir)) fs.mkdirSync(dbDocsDir, { recursive: true })

// Parse connection string
// e.g. postgres://user:pw@host:5432/dbname?sslmode=disable
let url
try { url = new URL(connUrl) } catch (e) {
  console.error('❌ Invalid connection string in .env:', connUrl)
  process.exit(1)
}
const proto = url.protocol.replace(':', '')
if (!/^postgres/i.test(proto)) {
  console.error('❌ Only postgres connection strings are supported')
  process.exit(1)
}
const user = decodeURIComponent(url.username || '')
const password = decodeURIComponent(url.password || '')
const hostRaw = url.hostname || 'localhost'
const port = url.port || '5432'
const dbname = (url.pathname || '/').replace(/^\//, '') || ''
if (!dbname) {
  console.error('❌ Could not infer database name from URL')
  process.exit(1)
}

// For Docker containers to reach host DB on Windows/macOS:
const dockerHost = (hostRaw === 'localhost' || hostRaw === '127.0.0.1') ? 'host.docker.internal' : hostRaw

function sh (cmd, opts = {}) {
  console.log('→', cmd)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function runDump () {
  const schemaPath = path.join(outDir, 'schema.sql').replace(/\\/g, '/')
  // Use official postgres image to run pg_dump against host DB
  const cmd = `docker run --rm -v ${outDir.replace(/\\/g, '/')}:/out --network host -e PGPASSWORD="${password}" postgres:16 ` +
              `pg_dump -s -h ${dockerHost} -p ${port} -U ${user} -d ${dbname} -f /out/schema.sql`
  sh(cmd)
  console.log(`✅ schema.sql written to ${schemaPath}`)
}

function runSchemaSpy () {
  // SchemaSpy needs only connection params; output to backend/docs/db
  // Note: --network host + host.docker.internal works on Windows/macOS
  const cmd = `docker run --rm -v ${dbDocsDir.replace(/\\/g, '/')}:/output --network host schemaspy/schemaspy:latest ` +
              `-t pgsql -host ${dockerHost} -port ${port} -db ${dbname} -u ${user} -p ${password} -s public`
  sh(cmd)
  console.log(`✅ SchemaSpy HTML at ${path.join(dbDocsDir, 'index.html')}`)
}

function runDbdocsBuild () {
  const outDbml = path.join(outDir, 'database.dbml')
  if (!fs.existsSync(outDbml)) {
    console.warn('⚠️ database.dbml not found; running db2dbml first…')
    runDb2dbml() // statt runDump()
  }
  const cmd = `npx --yes dbdocs build "${outDbml}" --project ${dbname}`
  sh(cmd)
  console.log('✅ dbdocs build complete (opened in browser)')
}

function runDb2dbml () {
  const outDbml = path.join(outDir, 'database.dbml')
  const cmd = `npx --yes dbdocs db2dbml postgres "${connUrl}" -o ${outDbml}`
  sh(cmd)
  console.log(`✅ DBML written to ${outDbml}`)
}

const doDump = steps.size ? steps.has('dump') : true
const doSchemaSpy = steps.size ? steps.has('schemaspy') : true
const doDbdocs = steps.size ? steps.has('dbdocs') : true
const doDbml = steps.size ? steps.has('dbml') : true

// Run
try {
  if (doDump) runDump()
  if (doSchemaSpy) runSchemaSpy()
  if (doDbml) runDb2dbml()
  if (doDbdocs && !noHosted) runDbdocsBuild() // ruft bei Bedarf selbst runDb2dbml()
} catch (e) {
  console.error('❌ Failed:', e.message || e)
  process.exit(1)
}
