const express = require('express');
const router = express.Router();
const {
  getInventoriesForPrepOrdering,
  calculatePrepSuggestions,
  sendPrepEmail,
  getPrepOrderDates,
  getPrepOrdersForView,
  deletePrepOrder
} = require('../controllers/preporderingController');

router.get('/inventories', getInventoriesForPrepOrdering);
router.post('/calculate', calculatePrepSuggestions);
router.post('/send-email', sendPrepEmail);

// ── View Prep Orders ──
router.get('/view/dates', getPrepOrderDates);
router.get('/view', getPrepOrdersForView);
router.delete('/view/:id', deletePrepOrder);

module.exports = router;