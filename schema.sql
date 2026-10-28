-- ==========================================================
--  Real Joyería Aguachica — esquema de base de datos
--  Seguro de ejecutar varias veces: no borra ni modifica datos existentes.
--  Deducido del código (app.js y vistas). Si tu base local tiene columnas
--  extra, compáralo con:  pg_dump --schema-only real_joyeria
-- ==========================================================

CREATE TABLE IF NOT EXISTS categorias (
  id            SERIAL PRIMARY KEY,
  nombre        VARCHAR(100) NOT NULL,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  orden         INTEGER      NOT NULL DEFAULT 0,
  en_portada    BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS productos (
  id              SERIAL PRIMARY KEY,
  nombre          VARCHAR(150) NOT NULL,
  slug            VARCHAR(200) NOT NULL UNIQUE,
  categoria_slug  VARCHAR(100),
  material        VARCHAR(50),
  para            VARCHAR(50)  NOT NULL DEFAULT 'unisex',
  precio          NUMERIC(12,2),
  imagen          TEXT,
  descripcion     TEXT,
  destacado       BOOLEAN      NOT NULL DEFAULT FALSE,
  activo          BOOLEAN      NOT NULL DEFAULT TRUE,
  piedra          VARCHAR(20),
  talla           VARCHAR(200),
  disponibilidad  VARCHAR(20)  NOT NULL DEFAULT 'disponible'
);

CREATE INDEX IF NOT EXISTS idx_productos_activo     ON productos (activo);
CREATE INDEX IF NOT EXISTS idx_productos_categoria  ON productos (categoria_slug);

CREATE TABLE IF NOT EXISTS usuarios_admin (
  id             SERIAL PRIMARY KEY,
  usuario        VARCHAR(80)  NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  nombre         VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS consultas (
  id              SERIAL PRIMARY KEY,
  nombre          VARCHAR(100) NOT NULL,
  telefono        VARCHAR(30)  NOT NULL,
  mensaje         TEXT         NOT NULL,
  acepta_datos    BOOLEAN      NOT NULL DEFAULT FALSE,
  leida           BOOLEAN      NOT NULL DEFAULT FALSE,
  fecha_creacion  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS configuracion (
  clave  VARCHAR(50) PRIMARY KEY,
  valor  TEXT NOT NULL DEFAULT ''
);
