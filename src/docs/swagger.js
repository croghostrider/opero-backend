const pkg = require('../../package.json')

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Opero API',
    version: pkg.version || '1.0.0',
    description:
      'Opero API – Auto-generiert aus JSDoc. Auth via Bearer JWT. Tenant via RLS.'
  },
  servers: [
    { url: 'http://localhost:4000', description: 'Local' }
  ],
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
}

const swaggerJsdocOptions = {
  definition: swaggerDefinition,
  apis: [
    // alle Routen, in denen du JSDoc-Kommentare ergänzt
    'src/routes/*.js',
    'src/payments/*.js'
  ]
}

module.exports = { swaggerJsdocOptions }
