const express = require('express');
const router = express.Router();
const {
  getInventoriesForPrepOrdering,
  calculatePrepSuggestions,
  sendPrepEmail
} = require('../controllers/preporderingController');

router.get('/inventories', getInventoriesForPrepOrdering);
router.post('/calculate', calculatePrepSuggestions);
router.post('/send-email', sendPrepEmail);

module.exports = router;