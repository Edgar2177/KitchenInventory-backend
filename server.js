const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { testConnection } = require('./src/config/database');

const app = express();
const PORT = process.env.PORT || 5000;

// Configuración SIMPLE pero efectiva de CORS
const corsOptions = {
  origin: [
    'http://invkitchen.callhospitality.ca',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Importar rutas
const productTypesRoutes = require('./src/routes/productTypes');
app.use('/api/product-types', productTypesRoutes);

const categoriesRoutes = require('./src/routes/productCategories');
app.use('/api/categories', categoriesRoutes);

const storesRoutes = require('./src/routes/stores');
app.use('/api/stores', storesRoutes);

const locationRoutes = require('./src/routes/locations');
app.use('/api/locations', locationRoutes);

const vendorsRoutes = require('./src/routes/vendors');
app.use('/api/vendors', vendorsRoutes);

const productsRoutes = require('./src/routes/products');
app.use('/api/products', productsRoutes);

const productsByStoreRoutes = require('./src/routes/productsByStore');
app.use('/api/products-by-store', productsByStoreRoutes);

// Rutas de autenticación y usuarios
const authRoutes = require('./src/routes/auth');
app.use('/api/auth', authRoutes);

const usersRoutes = require('./src/routes/users');
app.use('/api/users', usersRoutes);

const importRoutes = require('./src/routes/import');
app.use('/api/import', importRoutes);

const recipesRoutes = require('./src/routes/recipes');
app.use('/api/recipes', recipesRoutes);

const posRoutes = require('./src/routes/pos');
app.use('/api/pos', posRoutes);

const inventoriesRoutes = require('./src/routes/inventories');
app.use('/api/inventories', inventoriesRoutes);

const prepsRoutes = require('./src/routes/preps');
app.use('/api/preps', prepsRoutes);

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada',
    path: req.originalUrl
  });
});

app.listen(PORT, async () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  await testConnection();
});