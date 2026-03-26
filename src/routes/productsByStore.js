const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const {
  getAllProductsByStore,
  getProductsByStoreId,
  assignProductToStore,
  updateProductInStore,
  removeProductFromStore,
  importProductsByStore  // <-- agregar
} = require('../controllers/productsByStoreController');

// IMPORTANTE: /import debe ir ANTES de /:id para que no lo intercepte
router.post('/import', upload.single('file'), importProductsByStore);  // <-- agregar

router.get('/', getAllProductsByStore);
router.get('/store/:storeId', getProductsByStoreId);
router.post('/', assignProductToStore);
router.put('/:id', updateProductInStore);
router.delete('/:id', removeProductFromStore);

module.exports = router;