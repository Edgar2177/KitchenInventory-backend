const express = require('express');
const router = express.Router();
const {
  getInventoriesForOrdering,
  calculateOrderSuggestions,
  createOrder,
  getAllOrders,
  getOrderById,
  sendOrderEmail,
  getOrderDates,      
  getOrdersForView,
  getProductsForManualOrder,
  deleteOrder
} = require('../controllers/ordersController');

router.get('/inventories', getInventoriesForOrdering);
router.post('/calculate', calculateOrderSuggestions);
router.get('/view/dates', getOrderDates);
router.get('/view', getOrdersForView);

// ✅ Rutas específicas SIEMPRE antes de /:id
router.get('/manual-products', getProductsForManualOrder);

// Rutas dinámicas al final
router.get('/', getAllOrders);
router.get('/:id', getOrderById);
router.post('/', createOrder);
router.delete('/:id', deleteOrder);
router.post('/:id/send-email', sendOrderEmail);

module.exports = router;