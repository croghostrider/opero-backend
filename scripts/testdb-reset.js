#!/usr/bin/env node
/**
 * DROP + CREATE test database mit Least-Privilege-Rollen & Grants.
 * Siehe testdb-create.js für Env-Variablen.
 */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })
const { Client } = require('pg')

function parseUrl (urlStr, fallbackDb = 'opero_test') {
  const u = new URL(urlStr)
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: (u.pathname || '/').replace(/^\//, '') || fallbackDb,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || '')
  }
}
function qIdent (name) {
  return `"${String(name).replace(/"/g, '""')}"`
}
function qLiteral (s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

(async () => {
  const testUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  if (!testUrl) {
    console.error('❌ TEST_DATABASE_URL (oder DATABASE_URL) fehlt in .env')
    process.exit(1)
  }
  const testCfg = parseUrl(testUrl, 'opero_test')
  const adminUrl = process.env.ADMIN_DATABASE_URL || testUrl
  const adminCfg = parseUrl(adminUrl, 'postgres')

  const APP_ROLE = process.env.APP_DB_ROLE || (testCfg.user || 'opero_app')
  const OWNER_ROLE = process.env.APP_DB_OWNER || 'opero_owner'
  const APP_PASS = process.env.APP_DB_PASSWORD || testCfg.password || ''

  const admin = new Client({
    host: adminCfg.host,
    port: adminCfg.port,
    user: adminCfg.user,
    password: adminCfg.password,
    database: 'postgres'
  })

  try {
    await admin.connect()

    // DB droppen (FORCE, sonst normal)
    const dbName = testCfg.database
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${qIdent(dbName)} WITH (FORCE)`)
    } catch (e) {
      if (/syntax error/i.test(e.message)) {
        await admin.query(`DROP DATABASE IF EXISTS ${qIdent(dbName)}`)
      } else {
        throw e
      }
    }

    console.log('1 ok')
    console.log(testCfg)
    console.log(adminCfg)

    // Rollen (Owner & App) sauber anlegen/härten
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${qLiteral(OWNER_ROLE)}) THEN
          CREATE ROLE ${qIdent(OWNER_ROLE)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
        ELSE
          ALTER ROLE ${qIdent(OWNER_ROLE)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
        END IF;
      END$$;
    `)

    console.log('2 ok')

    const pwSql = APP_PASS ? ` PASSWORD ${qLiteral(APP_PASS)}` : ''
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${qLiteral(APP_ROLE)}) THEN
          CREATE ROLE ${qIdent(APP_ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT${pwSql};
        ELSE
          ALTER ROLE ${qIdent(APP_ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT${pwSql};
        END IF;
      END$$;
    `)

    // DB neu erstellen (Owner = OWNER_ROLE)
    await admin.query(`CREATE DATABASE ${qIdent(dbName)} OWNER ${qIdent(OWNER_ROLE)}`)
    console.log(`✅ Test-DB neu erstellt: ${dbName} (Owner: ${OWNER_ROLE})`)

    // Grants/Default-Privs in der neuen DB setzen
    const db = new Client({
      host: adminCfg.host,
      port: adminCfg.port,
      user: adminCfg.user,
      password: adminCfg.password,
      database: dbName
    })
    await db.connect()

    await db.query(`GRANT CONNECT ON DATABASE ${qIdent(dbName)} TO ${qIdent(APP_ROLE)}`)
    await db.query(`GRANT USAGE ON SCHEMA public TO ${qIdent(APP_ROLE)}`)
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${qIdent(APP_ROLE)}`)
    await db.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${qIdent(APP_ROLE)}`)
    await db.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qIdent(APP_ROLE)}
    `)
    await db.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO ${qIdent(APP_ROLE)}
    `)

    await db.end()
    console.log('✅ Rollen & Grants gesetzt. TEST_DATABASE_URL bitte als App-Rolle (NOSUPERUSER) verwenden.')
  } catch (e) {
    console.error('❌ Fehler beim Reset der Test-DB:', e.message)
    process.exit(1)
  } finally {
    await admin.end()
  }
})()
