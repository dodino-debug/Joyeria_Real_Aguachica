// Crea o actualiza el usuario administrador (contraseña cifrada con bcrypt).
// Uso (PowerShell):
//   $env:ADMIN_USUARIO="admin"; $env:ADMIN_NOMBRE="Administrador"; $env:ADMIN_PASSWORD="tu-clave-larga"
//   node scripts/crear_admin.js
// Usa DATABASE_URL (Neon) si está definida; si no, la base local del .env.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

(async () => {
  const usuario = process.env.ADMIN_USUARIO;
  const nombre = process.env.ADMIN_NOMBRE || usuario;
  const password = process.env.ADMIN_PASSWORD;
  if (!usuario || !password || password.length < 10) {
    console.error('Define ADMIN_USUARIO y ADMIN_PASSWORD (mínimo 10 caracteres).');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO usuarios_admin (usuario, password_hash, nombre) VALUES ($1, $2, $3)
     ON CONFLICT (usuario) DO UPDATE SET password_hash = EXCLUDED.password_hash, nombre = EXCLUDED.nombre`,
    [usuario, hash, nombre]
  );
  console.log(`✅ Administrador "${usuario}" listo.`);
  await db.end();
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
