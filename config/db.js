const { Pool } = require('pg');
require('dotenv').config();

// Producción (Neon): una sola cadena de conexión en DATABASE_URL (incluye SSL).
// Desarrollo local: se siguen usando DB_HOST, DB_USER, DB_PASSWORD, DB_NAME y DB_PORT.
const config = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: true },
      max: 5,                          // el plan gratis de Neon tiene pocas conexiones
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000   // Neon puede tardar unos segundos en "despertar"
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'real_joyeria',
      port: process.env.DB_PORT || 5432
    };

const pool = new Pool(config);

pool.on('connect', () => {
  console.log('⚡ Conectado exitosamente a PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en el cliente de PostgreSQL:', err);
});

module.exports = pool;
