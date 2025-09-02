/* eslint-env jest */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })

const fs = require('fs')
const { Pool, Client } = require('pg')
const { URL } = require('url')

// 1) DB-URL bestimmen (Tests > normal)
const dbUrl =
  (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL)
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL

if (!dbUrl) {
  throw new Error('Keine gültige DATABASE_URL oder TEST_DATABASE_URL gefunden!')
}

// 2) app.js soll dieselbe URL nutzen
process.env.DATABASE_URL = dbUrl

// Hilfsfunktionen
const qIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"'

function getAppUserFromUrl (urlStr) {
  try {
    const u = new URL(urlStr)
    // URL.username ist percent-encoded
    return decodeURIComponent(u.username) || 'opero_app'
  } catch {
    return 'opero_app'
  }
}

const APP_ROLE = process.env.APP_DB_ROLE || getAppUserFromUrl(dbUrl)
const OWNER_ROLE = process.env.APP_DB_OWNER || 'opero_owner'

// 3) App-Pool (Least-Privilege)
const pool = new Pool({ connectionString: dbUrl, ssl: false })

// SQL-Datei ausführen
async function runSqlFile (client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8')
  await client.query(sql)
}

// Admin-Helfer (nur wenn ADMIN_DATABASE_URL gesetzt)
async function withAdmin (fn) {
  const adminUrl = process.env.ADMIN_DATABASE_URL
  if (!adminUrl) return null

  const admin = new Client({ connectionString: adminUrl, ssl: false })
  await admin.connect()
  try {
    return await fn(admin)
  } finally {
    await admin.end()
  }
}

async function ensureExtensionsWithAdmin () {
  if (!process.env.ADMIN_DATABASE_URL) return
  await withAdmin(async (admin) => {
    await admin.query('BEGIN')
    try {
      // optional, falls du gen_random_uuid() verwenden willst:
      await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public')
      await admin.query('COMMIT')
    } catch (e) {
      try { await admin.query('ROLLBACK') } catch {}
      throw e
    }
  })
}

/**
 * Test-sicheres Reset:
 * - Mit ADMIN_DATABASE_URL: DROP/CREATE SCHEMA public (Owner=OWNER_ROLE), Rechte an APP_ROLE
 * - Ohne Admin: Nur Objekte der App-Rolle löschen, Schema unangetastet lassen
 */
async function resetSchemaPublicSmart (appClient) {
  if (process.env.NODE_ENV !== 'test') return

  // Weg 1: Admin vorhanden → hartes Reset des public-Schemas
  if (process.env.ADMIN_DATABASE_URL) {
    await withAdmin(async (admin) => {
      await admin.query('BEGIN')
      try {
        await admin.query('DROP SCHEMA IF EXISTS public CASCADE')
        await admin.query(`CREATE SCHEMA public AUTHORIZATION ${qIdent(OWNER_ROLE)}`)
        await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${qIdent(APP_ROLE)}`)
        // optional härter: niemand sonst darf CREATE
        await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
        await admin.query('COMMIT')
      } catch (e) {
        try { await admin.query('ROLLBACK') } catch {}
        throw e
      }
    })
    return
  }

  // Weg 2: Kein Admin → nur Objekte der App-Rolle wegputzen
  await appClient.query('DROP OWNED BY CURRENT_USER CASCADE')

  // Falls das Schema nicht dir gehört, kann dieses GRANT fehlschlagen – try/catch bewusst.
  try {
    await appClient.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${qIdent(APP_ROLE)}`)
  } catch (_) {
    // Ignorieren – idealerweise hat dein testdb-create.js das bereits sauber gesetzt.
  }
}

// Migrationen ausführen
async function migrate () {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Tests: Schema-Reset (smart)
    await resetSchemaPublicSmart(client)

    await ensureExtensionsWithAdmin()

    // migrations/ Ordner ermitteln
    const migDir = path.resolve(__dirname, '..', 'migrations')
    const fallbackDir = path.resolve(__dirname, '..', '..', 'migrations')
    const dir = fs.existsSync(migDir) ? migDir : fallbackDir

    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.sql$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

    for (const f of files) {
      const full = path.join(dir, f)
      await runSqlFile(client, full)
    }

    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('Migration failed:', e)
    throw e
  } finally {
    client.release()
  }
}

// 4) App NACH dem Setzen der ENV laden (damit app.js denselben Pool nutzt)
const app = require('../src/app')

// Jest Hooks
beforeAll(async () => {
  await migrate()
})

afterAll(async () => {
  try { await pool.end() } catch {}

  const appPool = app.get && app.get('pool')
  if (appPool && typeof appPool.end === 'function') {
    try { await appPool.end() } catch {}
  }
})

jest.setTimeout(30000)

module.exports = { pool }
