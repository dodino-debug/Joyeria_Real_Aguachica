// ==========================================================
//  Real Joyería Aguachica — servidor principal (app.js)
// ==========================================================
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const db = require('./config/db'); // Conexión a PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '573000000000';
const ES_PRODUCCION = process.env.NODE_ENV === 'production';

// Imágenes: con CLOUDINARY_URL se suben a la nube (producción);
// sin ella se guardan en public/uploads (desarrollo local, como hasta ahora).
const USAR_CLOUDINARY = Boolean(process.env.CLOUDINARY_URL);
if (USAR_CLOUDINARY) cloudinary.config({ secure: true }); // lee CLOUDINARY_URL solo
else if (ES_PRODUCCION) console.warn('⚠️  Falta CLOUDINARY_URL: las imágenes subidas se perderán al reiniciar el servidor.');

// El secreto de sesión es obligatorio: sin él, cualquiera podría falsificar sesiones
if (!process.env.SESSION_SECRET) {
  console.error('❌ Falta SESSION_SECRET en el archivo .env. El servidor no se iniciará.');
  process.exit(1);
}

// ==========================================================
//  CONSTANTES Y UTILIDADES
// ==========================================================
const PIEDRAS_VALIDAS = ['esmeralda', 'rubi', 'zafiro', 'diamante', 'otra'];
const DISPONIBILIDADES_VALIDAS = ['disponible', 'agotado', 'bajo_pedido'];
const PUBLICOS_VALIDOS = ['mujer', 'hombre', 'ninos', 'pareja', 'unisex'];
const MATERIALES_VALIDOS = ['oro', 'plata_925'];

// Texto limpio y con largo máximo (si no es texto, devuelve '')
const txt = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// "6, 7,, 8 " -> "6, 7, 8"  (vacío -> null)
const limpiarTallas = (v) =>
  txt(v, 400).split(',').map(t => t.trim()).filter(Boolean).join(', ').slice(0, 200) || null;

// Id numérico estricto desde la URL ("12" -> 12; "12abc" o "x" -> null)
const aId = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);

// Borra un archivo local sin romper nada si ya no existe
const borrarArchivo = (ruta) => { if (ruta) fs.unlink(ruta, () => {}); };

// Descarta una subida recién hecha (si luego falla la validación o el guardado)
const descartarSubida = (file) => {
  if (!file) return;
  if (file.publicId) cloudinary.uploader.destroy(file.publicId).catch(() => {});
  else borrarArchivo(file.path);
};

// Borra una imagen vieja a partir de la URL guardada en la base de datos
const borrarImagenAnterior = (url) => {
  if (!url) return;
  if (url.startsWith('/uploads/')) {
    borrarArchivo(path.join(CARPETA_UPLOADS, path.basename(url)));
    return;
  }
  const m = url.match(/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i);
  if (m && USAR_CLOUDINARY) cloudinary.uploader.destroy(m[1]).catch(() => {});
};

// ==========================================================
//  SUBIDA DE IMÁGENES (Multer)
// ==========================================================
const CARPETA_UPLOADS = path.join(__dirname, 'public/uploads');
if (!USAR_CLOUDINARY) fs.mkdirSync(CARPETA_UPLOADS, { recursive: true });

const EXTENSIONES_PERMITIDAS = ['.jpg', '.jpeg', '.png', '.webp'];
const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const TAMANO_MAX_IMAGEN = 8 * 1024 * 1024; // 8 MB

const storage = USAR_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({
  destination: (req, file, cb) => cb(null, CARPETA_UPLOADS),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'joya-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: TAMANO_MAX_IMAGEN },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (EXTENSIONES_PERMITIDAS.includes(ext) && MIMES_PERMITIDOS.includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Formato de imagen no permitido. Usa JPG, PNG o WEBP.'));
  }
});

// Envuelve la subida para responder con un mensaje claro si falla.
// Deja en req.file.url la dirección final de la imagen (nube o /uploads/...)
const subirImagen = (req, res, next) => {
  upload.single('imagen')(req, res, (err) => {
    if (err) {
      const mensaje = (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        ? 'La imagen supera el tamaño máximo de 8 MB.'
        : (err.message || 'No se pudo subir la imagen.');
      return res.status(400).send(mensaje);
    }
    if (!req.file) return next();

    if (!USAR_CLOUDINARY) {
      req.file.url = `/uploads/${req.file.filename}`;
      return next();
    }

    const flujo = cloudinary.uploader.upload_stream(
      {
        folder: 'real-joyeria',
        resource_type: 'image',
        // Reduce el peso sin perder calidad visible (ahorra cuota del plan gratis)
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }]
      },
      (errorNube, resultado) => {
        if (errorNube || !resultado) {
          console.error('Error subiendo a Cloudinary:', errorNube && errorNube.message);
          return res.status(502).send('No se pudo guardar la imagen. Inténtalo de nuevo.');
        }
        req.file.url = resultado.secure_url;
        req.file.publicId = resultado.public_id;
        next();
      }
    );
    flujo.end(req.file.buffer);
  });
};

// ==========================================================
//  CONFIGURACIÓN DE EXPRESS
// ==========================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Render (y similares) ponen un proxy HTTPS delante: necesario para req.ip y cookies seguras
if (ES_PRODUCCION) app.set('trust proxy', 1);

// Comprobación de salud para Render (no toca la base de datos)
app.get('/health', (req, res) => res.status(200).send('ok'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sesión del administrador
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24, httpOnly: true, sameSite: 'lax', secure: ES_PRODUCCION } // 24 horas; secure solo con HTTPS
}));

// ==========================================================
//  CONFIGURACIÓN DEL SITIO (editable desde el panel)
// ==========================================================
const CONFIG_POR_DEFECTO = {
  whatsapp: WHATSAPP_NUMBER,
  telefono: '',
  horario: 'Lunes a Sábado: 8:00 AM - 6:30 PM',
  direccion: 'Aguachica, Cesar, Colombia',
  instagram: '',
  facebook: '',
  tiktok: ''
};
let configCache = null;
let configCacheTiempo = 0;

async function obtenerConfig() {
  if (configCache && Date.now() - configCacheTiempo < 60 * 1000) return configCache;
  try {
    const r = await db.query('SELECT clave, valor FROM configuracion');
    const cfg = { ...CONFIG_POR_DEFECTO };
    r.rows.forEach(({ clave, valor }) => {
      if (clave in cfg && valor !== '') cfg[clave] = valor;
    });
    configCache = cfg;
    configCacheTiempo = Date.now();
    return cfg;
  } catch (error) {
    console.error('Error cargando la configuración:', error.message);
    return configCache || CONFIG_POR_DEFECTO; // el sitio sigue funcionando
  }
}

// Disponible en TODAS las vistas como `config` y `whatsappNumber`
app.use(async (req, res, next) => {
  const cfg = await obtenerConfig();
  res.locals.config = cfg;
  res.locals.whatsappNumber = cfg.whatsapp;
  next();
});

// ==========================================================
//  LÍMITE DE INTENTOS POR IP (en memoria, sin dependencias)
// ==========================================================
function limitarIntentos({ max, ventanaMs, mensaje }) {
  const registro = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [ip, marcas] of registro) {
      if (!marcas.some(t => ahora - t < ventanaMs)) registro.delete(ip);
    }
  }, ventanaMs).unref();

  return (req, res, next) => {
    const ahora = Date.now();
    const recientes = (registro.get(req.ip) || []).filter(t => ahora - t < ventanaMs);
    if (recientes.length >= max) {
      return res.status(429).send(mensaje || 'Demasiados intentos. Inténtalo más tarde.');
    }
    recientes.push(ahora);
    registro.set(req.ip, recientes);
    next();
  };
}

const limitarContacto = limitarIntentos({
  max: 8,
  ventanaMs: 60 * 60 * 1000,
  mensaje: 'Has enviado demasiados mensajes. Escríbenos por WhatsApp o inténtalo más tarde.'
});

const limitarLogin = limitarIntentos({
  max: 10,
  ventanaMs: 15 * 60 * 1000,
  mensaje: 'Demasiados intentos de inicio de sesión. Espera 15 minutos.'
});

// Middleware de autenticación para proteger las rutas /admin
const requiereAdmin = (req, res, next) => {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
};

// ==========================================================
//  RUTAS PÚBLICAS
// ==========================================================

// Inicio
app.get('/', async (req, res) => {
  try {
    const [resProductos, resCategorias] = await Promise.all([
      db.query('SELECT * FROM productos WHERE activo = TRUE AND destacado = TRUE LIMIT 4'),
      db.query('SELECT * FROM categorias WHERE en_portada = TRUE ORDER BY orden ASC, id ASC')
    ]);

    res.render('index', {
      titulo: 'Real Joyería Aguachica — Joyas que hacen especial cada momento',
      categorias: resCategorias.rows,
      productos: resProductos.rows
    });
  } catch (error) {
    console.error('Error cargando la página principal:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Catálogo con filtros
app.get('/catalogo', async (req, res) => {
  try {
    const buscar = txt(req.query.buscar, 100);
    const categoria = txt(req.query.categoria, 100);
    const material = txt(req.query.material, 50);
    const publico = txt(req.query.publico, 20);
    const piedra = txt(req.query.piedra, 20);

    let query = 'SELECT * FROM productos WHERE activo = TRUE';
    const params = [];

    // 1. Búsqueda por nombre
    if (buscar) {
      params.push(`%${buscar}%`);
      query += ` AND LOWER(nombre) LIKE LOWER($${params.length})`;
    }

    // 2. Colección / categoría
    if (categoria) {
      params.push(categoria);
      query += ` AND categoria_slug = $${params.length}`;
    }

    // 3. Material (metal)
    if (material) {
      params.push(material);
      query += ` AND material = $${params.length}`;
    }

    // 4. Público (columna 'para'). Unisex y Pareja aparecen en Dama y en Caballero
    if (publico === 'mujer' || publico === 'hombre') {
      params.push(publico);
      query += ` AND para IN ($${params.length}, 'unisex', 'pareja')`;
    } else if (publico === 'ninos') {
      query += ` AND para = 'ninos'`;
    }

    // 5. Esmeralda: con o sin (texto fijo, nada del usuario entra en la consulta)
    if (piedra === 'con_esmeralda') {
      query += ` AND piedra = 'esmeralda'`;
    } else if (piedra === 'sin_esmeralda') {
      query += ` AND piedra IS DISTINCT FROM 'esmeralda'`;
    }

    query += ' ORDER BY id DESC';

    const [resProductos, resCategorias] = await Promise.all([
      db.query(query, params),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC')
    ]);

    res.render('catalogo', {
      titulo: 'Catálogo de Joyas — Real Joyería Aguachica',
      productos: resProductos.rows,
      categorias: resCategorias.rows,
      filtrosActivos: { buscar, categoria, material, publico, piedra }
    });
  } catch (error) {
    console.error('Error cargando el catálogo:', error);
    res.status(500).send('Error interno del servidor al cargar el catálogo');
  }
});

// Ficha detallada del producto
app.get('/producto/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const resProducto = await db.query('SELECT * FROM productos WHERE slug = $1 AND activo = TRUE', [slug]);

    if (resProducto.rows.length === 0) {
      return res.status(404).render('404', {
        titulo: 'Producto no encontrado — Real Joyería Aguachica'
      });
    }

    const producto = resProducto.rows[0];

    // Relacionados: primero los de la misma categoría, luego se completa con otros
    const resRelacionados = await db.query(
      `SELECT * FROM productos
        WHERE id != $1 AND activo = TRUE
        ORDER BY (categoria_slug = $2) DESC NULLS LAST, id DESC
        LIMIT 3`,
      [producto.id, producto.categoria_slug]
    );

    res.render('producto_detalle', {
      titulo: `${producto.nombre} — Real Joyería Aguachica`,
      producto,
      relacionados: resRelacionados.rows
    });
  } catch (error) {
    console.error('Error cargando el producto:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Páginas informativas
app.get('/personaliza', (req, res) => {
  res.render('personaliza', { titulo: 'Diseños Personalizados — Real Joyería Aguachica' });
});

app.get('/esmeraldas', (req, res) => {
  res.render('esmeraldas', { titulo: 'Esmeraldas Naturales Muzo — Real Joyería Aguachica' });
});

app.get('/financiacion', (req, res) => {
  res.render('financiacion', { titulo: 'Planes de Financiación — Real Joyería Aguachica' });
});

// Contacto (con formulario)
const renderContacto = (res, extra = {}, status = 200) =>
  res.status(status).render('contacto', {
    titulo: 'Contacto y Ubicación — Real Joyería Aguachica',
    enviado: false,
    error: null,
    valores: { nombre: '', telefono: '', mensaje: '' },
    ...extra
  });

app.get('/contacto', (req, res) => {
  renderContacto(res, { enviado: req.query.enviado === '1' });
});

app.post('/contacto', limitarContacto, async (req, res) => {
  const b = req.body || {};
  const valores = { nombre: txt(b.nombre, 100), telefono: txt(b.telefono, 30), mensaje: txt(b.mensaje, 1000) };

  // Campo trampa para bots: si viene relleno, se finge éxito y no se guarda nada
  if (typeof b.sitio_web === 'string' && b.sitio_web !== '') {
    return res.redirect('/contacto?enviado=1');
  }

  const errores = [];
  if (valores.nombre.length < 2) errores.push('Escribe tu nombre.');
  const digitos = valores.telefono.replace(/\D/g, '');
  if (digitos.length < 7 || digitos.length > 15) errores.push('Escribe un teléfono o WhatsApp válido.');
  if (valores.mensaje.length < 5) errores.push('Escribe tu mensaje.');
  if (b.acepta_datos !== 'on') errores.push('Debes autorizar el tratamiento de tus datos para enviar la consulta.');

  if (errores.length > 0) {
    return renderContacto(res, { error: errores.join(' '), valores }, 400);
  }

  try {
    await db.query(
      'INSERT INTO consultas (nombre, telefono, mensaje, acepta_datos) VALUES ($1, $2, $3, TRUE)',
      [valores.nombre, valores.telefono, valores.mensaje]
    );
    res.redirect('/contacto?enviado=1');
  } catch (error) {
    console.error('Error guardando la consulta:', error);
    renderContacto(res, { error: 'No pudimos guardar tu mensaje. Escríbenos por WhatsApp.', valores }, 500);
  }
});

// ==========================================================
//  PANEL DE ADMINISTRACIÓN (/admin)
// ==========================================================

// Login
app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', limitarLogin, async (req, res) => {
  const { usuario, password } = req.body || {};
  try {
    if (typeof usuario !== 'string' || typeof password !== 'string') {
      return res.render('admin/login', { error: 'Usuario o contraseña incorrectos' });
    }

    const result = await db.query('SELECT * FROM usuarios_admin WHERE usuario = $1', [usuario]);
    if (result.rows.length > 0) {
      const admin = result.rows[0];
      const esHash = /^\$2[aby]\$/.test(admin.password_hash);
      let valida = false;

      if (esHash) {
        valida = await bcrypt.compare(password, admin.password_hash);
      } else if (password === admin.password_hash) {
        // TEMPORAL: migra una contraseña guardada en texto plano a hash en el primer login.
        // Cuando la contraseña ya esté cifrada en la BD, esta rama nunca se ejecuta y se puede borrar.
        valida = true;
        const nuevoHash = await bcrypt.hash(password, 12);
        await db.query('UPDATE usuarios_admin SET password_hash = $1 WHERE id = $2', [nuevoHash, admin.id]);
      }

      if (valida) {
        // Solo los datos necesarios; nunca se guarda el hash en la sesión
        req.session.admin = { id: admin.id, usuario: admin.usuario, nombre: admin.nombre };
        return res.redirect('/admin');
      }
    }
    res.render('admin/login', { error: 'Usuario o contraseña incorrectos' });
  } catch (error) {
    console.error('Error en login:', error);
    res.render('admin/login', { error: 'Error del servidor al iniciar sesión' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Dashboard: inventario de joyas
app.get('/admin', requiereAdmin, async (req, res) => {
  try {
    const [result, resCategorias, resNuevas] = await Promise.all([
      db.query('SELECT * FROM productos ORDER BY id DESC'),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC'),
      db.query('SELECT COUNT(*)::int AS n FROM consultas WHERE leida = FALSE')
        .catch(() => ({ rows: [{ n: 0 }] })) // si la tabla aún no existe, el panel igual abre
    ]);
    res.render('admin/dashboard', {
      admin: req.session.admin,
      productos: result.rows,
      categorias: resCategorias.rows,
      consultasNuevas: resNuevas.rows[0].n
    });
  } catch (error) {
    console.error('Error cargando dashboard:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Crear joya nueva
app.post('/admin/productos/nuevo', requiereAdmin, subirImagen, async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = txt(b.nombre, 150);
    if (!nombre) {
      descartarSubida(req.file);
      return res.status(400).send('El nombre de la joya es obligatorio.');
    }

    const precioTxt = txt(b.precio, 20);
    const precio = precioTxt === '' ? null : Number(precioTxt);
    if (precio !== null && (!Number.isFinite(precio) || precio < 0 || precio > 9999999999)) {
      descartarSubida(req.file);
      return res.status(400).send('El precio no es válido.');
    }

    const slug = nombre.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
      .slice(0, 120) + '-' + Date.now();

    const imagenUrl = req.file ? req.file.url : '/image/logo.jpg';
    const esDestacado = b.destacado === 'on' || b.destacado === 'true';
    const piedra = PIEDRAS_VALIDAS.includes(b.piedra) ? b.piedra : null;
    const disponibilidad = DISPONIBILIDADES_VALIDAS.includes(b.disponibilidad) ? b.disponibilidad : 'disponible';

    await db.query(
      `INSERT INTO productos
         (nombre, slug, categoria_slug, material, para, precio, imagen, descripcion, destacado, activo, piedra, talla, disponibilidad)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12)`,
      [nombre, slug, txt(b.categoria_slug, 100), txt(b.material, 50), txt(b.para, 50) || 'unisex',
       precio, imagenUrl, txt(b.descripcion, 2000) || null, esDestacado,
       piedra, limpiarTallas(b.talla), disponibilidad]
    );

    res.redirect('/admin');
  } catch (error) {
    console.error('Error creando producto:', error);
    descartarSubida(req.file);
    res.status(500).send('Error al guardar el producto');
  }
});

// Activar / desactivar (eliminación lógica)
app.post('/admin/productos/toggle/:id', requiereAdmin, async (req, res) => {
  try {
    const id = aId(req.params.id);
    if (id !== null) {
      await db.query('UPDATE productos SET activo = NOT activo WHERE id = $1', [id]);
    }
    res.redirect('/admin');
  } catch (error) {
    console.error('Error cambiando estado:', error);
    res.status(500).send('Error al actualizar');
  }
});

// Editar joya: formulario
app.get('/admin/productos/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const id = aId(req.params.id);
    if (id === null) return res.redirect('/admin');

    const [resProducto, resCategorias] = await Promise.all([
      db.query('SELECT * FROM productos WHERE id = $1', [id]),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC')
    ]);
    if (resProducto.rows.length === 0) return res.redirect('/admin');

    res.render('admin/editar', {
      admin: req.session.admin,
      producto: resProducto.rows[0],
      categorias: resCategorias.rows,
      error: null
    });
  } catch (error) {
    console.error('Error cargando el formulario de edición:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Editar joya: guardar cambios
app.post('/admin/productos/:id/editar', requiereAdmin, subirImagen, async (req, res) => {
  const id = aId(req.params.id);
  if (id === null) {
    descartarSubida(req.file);
    return res.redirect('/admin');
  }

  try {
    const [resProducto, resCategorias] = await Promise.all([
      db.query('SELECT * FROM productos WHERE id = $1', [id]),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC')
    ]);
    if (resProducto.rows.length === 0) {
      descartarSubida(req.file);
      return res.redirect('/admin');
    }
    const actual = resProducto.rows[0];

    const b = req.body || {};
    const precioTxt = txt(b.precio, 20);
    const datos = {
      nombre: txt(b.nombre, 150),
      categoria_slug: txt(b.categoria_slug, 100),
      material: txt(b.material, 50),
      para: txt(b.para, 50),
      precio: precioTxt === '' ? null : Number(precioTxt),
      piedra: PIEDRAS_VALIDAS.includes(b.piedra) ? b.piedra : null,
      talla: limpiarTallas(b.talla),
      disponibilidad: txt(b.disponibilidad, 20),
      descripcion: txt(b.descripcion, 2000) || null,
      destacado: b.destacado === 'on',
      activo: b.activo === 'on'
    };

    const errores = [];
    if (!datos.nombre) errores.push('El nombre es obligatorio.');
    if (!resCategorias.rows.some(c => c.slug === datos.categoria_slug)) errores.push('Elige una categoría válida.');
    if (!MATERIALES_VALIDOS.includes(datos.material) && datos.material !== actual.material) errores.push('Material no válido.');
    if (!PUBLICOS_VALIDOS.includes(datos.para)) errores.push('Público objetivo no válido.');
    if (!DISPONIBILIDADES_VALIDAS.includes(datos.disponibilidad)) errores.push('Disponibilidad no válida.');
    if (datos.precio !== null && (!Number.isFinite(datos.precio) || datos.precio < 0 || datos.precio > 9999999999)) {
      errores.push('El precio no es válido.');
    }

    if (errores.length > 0) {
      descartarSubida(req.file);
      return res.status(400).render('admin/editar', {
        admin: req.session.admin,
        producto: { ...actual, ...datos },
        categorias: resCategorias.rows,
        error: errores.join(' ')
      });
    }

    const imagenFinal = req.file ? req.file.url : actual.imagen;

    await db.query(
      `UPDATE productos
          SET nombre = $1, categoria_slug = $2, material = $3, para = $4, precio = $5,
              piedra = $6, talla = $7, disponibilidad = $8, descripcion = $9,
              destacado = $10, activo = $11, imagen = $12
        WHERE id = $13`,
      [datos.nombre, datos.categoria_slug, datos.material, datos.para, datos.precio,
       datos.piedra, datos.talla, datos.disponibilidad, datos.descripcion,
       datos.destacado, datos.activo, imagenFinal, id]
    );

    // Si se subió una foto nueva, borra la anterior (local o de Cloudinary)
    if (req.file) borrarImagenAnterior(actual.imagen);

    res.redirect('/admin');
  } catch (error) {
    console.error('Error editando producto:', error);
    descartarSubida(req.file);
    res.status(500).send('Error al guardar los cambios');
  }
});

// Configuración del sitio: formulario
app.get('/admin/configuracion', requiereAdmin, async (req, res) => {
  const cfg = await obtenerConfig();
  res.render('admin/configuracion', {
    admin: req.session.admin,
    cfg,
    error: null,
    ok: req.query.ok === '1'
  });
});

// Configuración del sitio: guardar
app.post('/admin/configuracion', requiereAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const errores = [];

    // WhatsApp: solo dígitos. Si son 10 y empiezan por 3, se antepone 57 (Colombia)
    let whatsapp = txt(b.whatsapp, 30).replace(/\D/g, '');
    if (/^3\d{9}$/.test(whatsapp)) whatsapp = '57' + whatsapp;
    if (!/^\d{10,15}$/.test(whatsapp)) {
      errores.push('El número de WhatsApp no es válido. Ejemplo: 573001234567.');
    }

    // Enlaces de redes: solo http(s), para evitar enlaces peligrosos
    const validarUrl = (valor, nombre) => {
      if (valor === '') return '';
      try {
        const u = new URL(valor);
        if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
      } catch (e) { /* cae al error de abajo */ }
      errores.push(`El enlace de ${nombre} debe comenzar con https://`);
      return valor;
    };

    const datos = {
      whatsapp,
      telefono: txt(b.telefono, 50),
      horario: txt(b.horario, 200),
      direccion: txt(b.direccion, 200),
      instagram: validarUrl(txt(b.instagram, 300), 'Instagram'),
      facebook: validarUrl(txt(b.facebook, 300), 'Facebook'),
      tiktok: validarUrl(txt(b.tiktok, 300), 'TikTok')
    };

    if (errores.length > 0) {
      return res.status(400).render('admin/configuracion', {
        admin: req.session.admin,
        cfg: datos,
        error: errores.join(' '),
        ok: false
      });
    }

    const filas = Object.entries(datos);
    await db.query(
      `INSERT INTO configuracion (clave, valor)
       SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
      [filas.map(f => f[0]), filas.map(f => f[1])]
    );

    configCache = null; // fuerza a recargar la configuración
    res.redirect('/admin/configuracion?ok=1');
  } catch (error) {
    console.error('Error guardando la configuración:', error);
    res.status(500).send('Error al guardar la configuración');
  }
});

// Bandeja de consultas
app.get('/admin/consultas', requiereAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM consultas ORDER BY fecha_creacion DESC LIMIT 200');
    res.render('admin/consultas', { admin: req.session.admin, consultas: r.rows });
  } catch (error) {
    console.error('Error cargando consultas:', error);
    res.status(500).send('Error interno del servidor');
  }
});

app.post('/admin/consultas/:id/leida', requiereAdmin, async (req, res) => {
  try {
    const id = aId(req.params.id);
    if (id !== null) {
      await db.query('UPDATE consultas SET leida = NOT leida WHERE id = $1', [id]);
    }
    res.redirect('/admin/consultas');
  } catch (error) {
    console.error('Error actualizando consulta:', error);
    res.status(500).send('Error al actualizar');
  }
});

app.post('/admin/consultas/:id/eliminar', requiereAdmin, async (req, res) => {
  try {
    const id = aId(req.params.id);
    if (id !== null) {
      await db.query('DELETE FROM consultas WHERE id = $1', [id]);
    }
    res.redirect('/admin/consultas');
  } catch (error) {
    console.error('Error eliminando consulta:', error);
    res.status(500).send('Error al eliminar');
  }
});

// ==========================================================
//  PÁGINA 404 (siempre al final, después de todas las rutas)
// ==========================================================
app.use((req, res) => {
  res.status(404).render('404', { titulo: 'Página no encontrada — Real Joyería Aguachica' });
});

// Manejador global de errores (último middleware)
app.use((err, req, res, next) => {
  console.error('Error no controlado:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Error interno del servidor');
});

// Escuchador del servidor (0.0.0.0 para que Render pueda alcanzarlo)
const servidor = app.listen(PORT, '0.0.0.0', () => {
  console.log(`👑 Servidor escuchando en el puerto ${PORT}`);
});
servidor.on('error', (err) => {
  console.error('❌ No se pudo iniciar el servidor:', err.message);
  process.exit(1);
});
