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
  deleteOrder
} = require('../controllers/ordersController');

// GET inventories for selector
router.get('/inventories', getInventoriesForOrdering);

// POST calculate order suggestions based on inventory
router.post('/calculate', calculateOrderSuggestions);

router.get('/view/dates', getOrderDates);
router.get('/view', getOrdersForView);

// CRUD orders
router.get('/', getAllOrders);
router.get('/:id', getOrderById);
router.post('/', createOrder);
router.delete('/:id', deleteOrder);
// Send order email to vendor
router.post('/:id/send-email', sendOrderEmail);

module.exports = router;