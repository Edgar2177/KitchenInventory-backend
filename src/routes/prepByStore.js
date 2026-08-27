const express = require('express');
const router = express.Router();
const {
  getPrepsByStore,
  updatePrepParReorder
} = require('../controllers/prepbystoreController');

router.get('/store/:storeId', getPrepsByStore);
router.put('/:id', updatePrepParReorder);

module.exports = router;