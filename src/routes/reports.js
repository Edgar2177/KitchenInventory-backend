const express = require('express');
const router = express.Router();
const { getVarianceReport } = require('../controllers/reportsController');

// GET /reports/variance-report?storeId=..&inventoryId=..
router.get('/variance-report', getVarianceReport);

module.exports = router;