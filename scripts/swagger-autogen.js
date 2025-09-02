#!/usr/bin/env node
/* Generate OpenAPI spec from routes using swagger-autogen (Windows-safe) */
'use strict'

const path = require('path')
const fs = require('fs')

// swagger-autogen init
// (OpenAPI 3; Logs an; du kannst disableLogs: true setzen, wenn gewünscht)
const swaggerAutogen = require('swagger-autogen')({
  openapi: '3.0.0',
  language: 'en-US'
})

// Hilfsfunktion: in POSIX-Pfad (für Windows!)
const toPosix = (p) => p.split(path.sep).join('/')

// Output-Ziel
const outDir = path.resolve(__dirname, '..', 'src', 'docs')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
const outputFile = path.join(outDir, 'swagger-output.json')

// Kandidaten-Dateien (nur echte Files angeben, nicht Ordner)
const candidates = [
  path.resolve(__dirname, '..', 'src', 'app.js')
]

// Nur existierende Files verwenden und in POSIX wandeln
const endpointsFiles = candidates
  .filter((f) => {
    const ok = fs.existsSync(f) && fs.statSync(f).isFile()
    if (!ok) console.warn(`⚠️  übersprungen (nicht gefunden): ${f}`)
    return ok
  })
  .map(toPosix)

const doc = {
  info: {
    title: 'Opero API',
    description: 'Auto-generierte OpenAPI-Doku (swagger-autogen)',
    version: '1.0.0'
  },
  servers: [{ url: 'http://localhost:4000', description: 'Local' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
    },
    schemas: {
      Product: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          vat_rate: { type: 'number', example: 2.6 },
          price: { type: 'number', example: 4.5 },
          created_at: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'name', 'price']
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } }
      }
    }
  },
  security: [{ bearerAuth: [] }]
};

(async () => {
  try {
    if (endpointsFiles.length === 0) {
      throw new Error('Keine Endpunkt-Dateien gefunden. Prüfe Pfade im Script.')
    }
    console.log('🔎 Endpoints:', endpointsFiles)
    await swaggerAutogen(toPosix(outputFile), endpointsFiles, doc)
    console.log('✅ OpenAPI generiert:', outputFile)
    process.exit(0)
  } catch (e) {
    console.error('❌ swagger-autogen fehlgeschlagen:', e.message || e)
    process.exit(1)
  }
})()
