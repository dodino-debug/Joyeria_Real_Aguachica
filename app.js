const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const db = require('./config/db'); // Conexión a PostgreSQL
const bcrypt = require('bcryptjs');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '573000000000';

// Configuración de almacenamiento de imágenes con Multer
const EXTENSIONES_PERMITIDAS = ['.jpg', '.jpeg', '.png', '.webp'];
const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const TAMANO_MAX_IMAGEN = 8 * 1024 * 1024; // 8 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public/uploads'));
  },
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

// Envuelve la subida para responder con un mensaje claro si falla
const subirImagen = (req, res, next) => {
  upload.single('imagen')(req, res, (err) => {
    if (err) {
      const mensaje = (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        ? 'La imagen supera el tamaño máximo de 8 MB.'
        : (err.message || 'No se pudo subir la imagen.');
      return res.status(400).send(mensaje);
    }
    next();
  });
};

// Configuración de Vistas
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de Sesión para el Admin
if (!process.env.SESSION_SECRET) {
  console.error('Falta SESSION_SECRET en el archivo .env. El servidor no se iniciará.');
  process.exit(1);
}

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 horas
}));

// Middleware de Autenticación para proteger las rutas /admin
const requiereAdmin = (req, res, next) => {
  if (req.session && req.session.admin) {
    return next();
  }
  res.redirect('/admin/login');
};

// Ruta Inicio
app.get('/', async (req, res) => {
  try {
    const resProductos = await db.query('SELECT * FROM productos WHERE activo = TRUE AND destacado = TRUE LIMIT 4');
    const resCategorias = await db.query('SELECT * FROM categorias WHERE en_portada = TRUE ORDER BY orden ASC, id ASC');

    res.render('index', {
      titulo: 'Real Joyería Aguachica — Joyas que hacen especial cada momento',
      categorias: resCategorias.rows,
      productos: resProductos.rows,
      whatsappNumber: WHATSAPP_NUMBER
    });
  } catch (error) {
    console.error('Error cargando la página principal:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta Catálogo con Filtros y PostgreSQL
app.get('/catalogo', async (req, res) => {
  try {
    const { buscar, categoria, material, publico, piedra } = req.query;

    let query = 'SELECT * FROM productos WHERE activo = TRUE';
    const params = [];

    // 1. Filtro por término de búsqueda (nombre)
    if (buscar && buscar.trim() !== '') {
      params.push(`%${buscar.trim()}%`);
      query += ` AND LOWER(nombre) LIKE LOWER($${params.length})`;
    }

    // 2. Filtro por Colección / Categoría
    if (categoria && categoria.trim() !== '') {
      params.push(categoria);
      query += ` AND categoria_slug = $${params.length}`;
    }

    // 3. Filtro por Material
    if (material && material.trim() !== '') {
      params.push(material);
      query += ` AND material = $${params.length}`;
    }

    // 4. Filtro por Público (columna 'para' en la BD)
    if (publico === 'mujer' || publico === 'hombre') {
      // Unisex y Pareja aparecen tanto en Dama como en Caballero
      params.push(publico);
      query += ` AND para IN ($${params.length}, 'unisex', 'pareja')`;
    } else if (publico === 'ninos') {
      query += ` AND para = 'ninos'`;
    }

    // 5. Filtro por Piedra: con o sin esmeralda
    if (piedra === 'con_esmeralda') {
      query += ` AND piedra = 'esmeralda'`;
    } else if (piedra === 'sin_esmeralda') {
      query += ` AND piedra IS DISTINCT FROM 'esmeralda'`;
    }

    query += ' ORDER BY id DESC';

    // Ejecución de consultas en paralelo
    const [resProductos, resCategorias] = await Promise.all([
      db.query(query, params),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC')
    ]);

    res.render('catalogo', {
      titulo: 'Catálogo de Joyas — Real Joyería Aguachica',
      productos: resProductos.rows,
      categorias: resCategorias.rows,
      filtrosActivos: {
        buscar: buscar || '',
        categoria: categoria || '',
        material: material || '',
        publico: publico || '',
        piedra: piedra || ''
      },
      whatsappNumber: WHATSAPP_NUMBER
    });
  } catch (error) {
    console.error('Error cargando el catálogo:', error);
    res.status(500).send('Error interno del servidor al cargar el catálogo');
  }
});

// Ruta Ficha Detallada del Producto
app.get('/producto/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const resProducto = await db.query('SELECT * FROM productos WHERE slug = $1 AND activo = TRUE', [slug]);

    if (resProducto.rows.length === 0) {
      return res.status(404).render('404', { 
        titulo: 'Producto no encontrado — Real Joyería Aguachica',
        whatsappNumber: WHATSAPP_NUMBER
      });
    }

    const producto = resProducto.rows[0];
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
      relacionados: resRelacionados.rows,
      whatsappNumber: WHATSAPP_NUMBER
    });
  } catch (error) {
    console.error('Error cargando el producto:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta Diseños Personalizados
app.get('/personaliza', (req, res) => {
  res.render('personaliza', {
    titulo: 'Diseños Personalizados — Real Joyería Aguachica',
    whatsappNumber: WHATSAPP_NUMBER
  });
});

// Ruta Esmeraldas
app.get('/esmeraldas', (req, res) => {
  res.render('esmeraldas', {
    titulo: 'Esmeraldas Naturales Muzo — Real Joyería Aguachica',
    whatsappNumber: WHATSAPP_NUMBER
  });
});

// Ruta Financiación
app.get('/financiacion', (req, res) => {
  res.render('financiacion', {
    titulo: 'Planes de Financiación — Real Joyería Aguachica',
    whatsappNumber: WHATSAPP_NUMBER
  });
});

// Ruta Contacto
app.get('/contacto', (req, res) => {
  res.render('contacto', {
    titulo: 'Contacto y Ubicación — Real Joyería Aguachica',
    whatsappNumber: WHATSAPP_NUMBER
  });
});

// ==========================================
// RUTAS DEL PANEL DE ADMINISTRACIÓN (/admin)
// ==========================================

// Vista Login Admin
app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

// Procesar Login Admin
app.post('/admin/login', async (req, res) => {
  const { usuario, password } = req.body;
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
        // TEMPORAL: migra la contraseña en texto plano a hash en el primer login.
        // Eliminar esta rama cuando el admin ya haya iniciado sesión una vez.
        valida = true;
        const nuevoHash = await bcrypt.hash(password, 12);
        await db.query('UPDATE usuarios_admin SET password_hash = $1 WHERE id = $2', [nuevoHash, admin.id]);
      }

      if (valida) {
        // Solo datos necesarios; nunca guardar el hash en la sesión
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

// Cerrar Sesión Admin
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Dashboard Principal Admin (Listar joyas)
app.get('/admin', requiereAdmin, async (req, res) => {
  try {
    const [result, resCategorias] = await Promise.all([
      db.query('SELECT * FROM productos ORDER BY id DESC'),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC')
    ]);
    res.render('admin/dashboard', {
      admin: req.session.admin,
      productos: result.rows,
      categorias: resCategorias.rows
    });
  } catch (error) {
    console.error('Error cargando dashboard:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Procesar Creación de Nueva Joya
app.post('/admin/productos/nuevo', requiereAdmin, subirImagen, async (req, res) => {
  try {
    const { nombre, categoria_slug, material, para, precio, descripcion, destacado, piedra, talla, disponibilidad } = req.body;
    const slug = nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') + '-' + Date.now();
    const imagenUrl = req.file ? `/uploads/${req.file.filename}` : '/image/logo.jpg';
    const esDestacado = destacado === 'on' || destacado === 'true';
    const PIEDRAS = ['esmeralda', 'rubi', 'zafiro', 'diamante', 'otra'];
    const DISPONIBILIDADES = ['disponible', 'agotado', 'bajo_pedido'];
    const piedraFinal = PIEDRAS.includes(piedra) ? piedra : null;
    const disponibilidadFinal = DISPONIBILIDADES.includes(disponibilidad) ? disponibilidad : 'disponible';
    const tallaFinal = (talla || '').split(',').map(t => t.trim()).filter(Boolean).join(', ').slice(0, 200) || null;

    await db.query(
      `INSERT INTO productos (nombre, slug, categoria_slug, material, para, precio, imagen, descripcion, destacado, activo, piedra, talla, disponibilidad)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12)`,
      [nombre, slug, categoria_slug, material, para, precio || null, imagenUrl, descripcion, esDestacado, piedraFinal, tallaFinal, disponibilidadFinal]
    );

    res.redirect('/admin');
  } catch (error) {
    console.error('Error creando producto:', error);
    res.status(500).send('Error al guardar el producto');
  }
});

// Cambiar Estado Activo/Inactivo (Eliminación lógica)
app.post('/admin/productos/toggle/:id', requiereAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('UPDATE productos SET activo = NOT activo WHERE id = $1', [id]);
    res.redirect('/admin');
  } catch (error) {
    console.error('Error cambiando estado:', error);
    res.status(500).send('Error al actualizar');
  }
});

// ==========================================
// EDITAR PRODUCTO
// ==========================================
const PIEDRAS_VALIDAS = ['esmeralda', 'rubi', 'zafiro', 'diamante', 'otra'];
const DISPONIBILIDADES_VALIDAS = ['disponible', 'agotado', 'bajo_pedido'];
const PUBLICOS_VALIDOS = ['mujer', 'hombre', 'ninos', 'pareja', 'unisex'];
const MATERIALES_VALIDOS = ['oro', 'plata_925'];
const txt = (v) => (typeof v === 'string' ? v.trim() : '');

// Formulario de edición
app.get('/admin/productos/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect('/admin');

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

// Guardar cambios
app.post('/admin/productos/:id/editar', requiereAdmin, subirImagen, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect('/admin');

  try {
    const [resProducto, resCategorias] = await Promise.all([
      db.query('SELECT * FROM productos WHERE id = $1', [id]),
      db.query('SELECT * FROM categorias ORDER BY orden ASC, id ASC')
    ]);
    if (resProducto.rows.length === 0) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.redirect('/admin');
    }
    const actual = resProducto.rows[0];

    const b = req.body;
    const precioTxt = txt(b.precio);
    const datos = {
      nombre: txt(b.nombre),
      categoria_slug: txt(b.categoria_slug),
      material: txt(b.material),
      para: txt(b.para),
      precio: precioTxt === '' ? null : Number(precioTxt),
      piedra: PIEDRAS_VALIDAS.includes(b.piedra) ? b.piedra : null,
      talla: txt(b.talla).split(',').map(t => t.trim()).filter(Boolean).join(', ').slice(0, 200) || null,
      disponibilidad: txt(b.disponibilidad),
      descripcion: txt(b.descripcion) || null,
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
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).render('admin/editar', {
        admin: req.session.admin,
        producto: { ...actual, ...datos },
        categorias: resCategorias.rows,
        error: errores.join(' ')
      });
    }

    const imagenFinal = req.file ? `/uploads/${req.file.filename}` : actual.imagen;

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

    // Si se subió una foto nueva, borra la anterior (solo si estaba en /uploads)
    if (req.file && actual.imagen && actual.imagen.startsWith('/uploads/')) {
      fs.unlink(path.join(__dirname, 'public/uploads', path.basename(actual.imagen)), () => {});
    }

    res.redirect('/admin');
  } catch (error) {
    console.error('Error editando producto:', error);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).send('Error al guardar los cambios');
  }
});

// Página 404 para cualquier ruta que no exista (debe ir después de todas las rutas)
app.use((req, res) => {
  res.status(404).render('404', {
    titulo: 'Página no encontrada — Real Joyería Aguachica',
    whatsappNumber: WHATSAPP_NUMBER
  });
});

// Escuchador del servidor
app.listen(PORT, () => {
  console.log(`👑 Servidor corriendo en http://localhost:${PORT}`);
});