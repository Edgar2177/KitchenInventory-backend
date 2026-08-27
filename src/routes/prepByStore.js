const express = require('express');
const router = express.Router();
const {
  getPrepsByStore,
  updatePrepParReorder
} = require('../controllers/prepByStoreController');

router.get('/store/:storeId', getPrepsByStore);
router.put('/:id', updatePrepParReorder);

module.exports = router;