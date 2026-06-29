const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const {
  getAllInventories,
  getInventoryById,
  createInventory,
  updateInventory,
  deleteInventory,
  toggleLockInventory,
  getAvailableProducts,
  reorderInventoryItems,
  getLastInventoryProducts,
  importInventoryFromExcel,
  getProductsForPrintInventory,
  getInventoriesByLocation,
  getInventoryProducts,
} = require('../controllers/inventoriesController');

// Rutas especiales con path fijo (deben estar ANTES de /:id)
router.post('/import', upload.single('file'), importInventoryFromExcel);
router.get('/available-products', getAvailableProducts);
router.get('/last-products/:locationId', getLastInventoryProducts);
router.get('/print-format', getProductsForPrintInventory);
router.get('/by-location/:locationId', getInventoriesByLocation);

// Rutas CRUD básicas
router.get('/', getAllInventories);
router.get('/:id', getInventoryById);
router.post('/', createInventory);
router.put('/:id', updateInventory);
router.delete('/:id', deleteInventory);

// Rutas especiales con /:id
router.patch('/:id/toggle-lock', toggleLockInventory);
router.patch('/:id/reorder', reorderInventoryItems);
router.get('/:inventoryId/products', getInventoryProducts);

module.exports = router;