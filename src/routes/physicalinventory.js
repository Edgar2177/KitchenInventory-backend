const express = require('express');
const router = express.Router();
const {
  getAllPhysicalInventories,
  getPhysicalInventoryById,
  getProductsForPhysicalInventory,
  createPhysicalInventory,
  updatePhysicalInventory,
  toggleLockPhysicalInventory,
  deletePhysicalInventory
} = require('../controllers/physicalinventoryController');

// GET    /api/physical-inventories?storeId=1
router.get('/', getAllPhysicalInventories);

// GET    /api/physical-inventories/products?storeId=1
router.get('/products', getProductsForPhysicalInventory);

// GET    /api/physical-inventories/:id
router.get('/:id', getPhysicalInventoryById);

// POST   /api/physical-inventories
router.post('/', createPhysicalInventory);

// PUT    /api/physical-inventories/:id
router.put('/:id', updatePhysicalInventory);

// PATCH  /api/physical-inventories/:id/toggle-lock
router.patch('/:id/toggle-lock', toggleLockPhysicalInventory);

// DELETE /api/physical-inventories/:id
router.delete('/:id', deletePhysicalInventory);

module.exports = router;