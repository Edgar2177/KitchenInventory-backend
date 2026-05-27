const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const {
  getAllModifiers,
  importModifiers,
  deleteModifier,
  clearStoreModifiers
} = require('../controllers/modifiersController');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/',                       getAllModifiers);
router.post('/import', upload.single('file'), importModifiers);
router.delete('/store/:storeId',      clearStoreModifiers);
router.delete('/:id',                 deleteModifier);

module.exports = router;