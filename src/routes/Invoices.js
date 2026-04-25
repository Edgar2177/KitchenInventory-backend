const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const {
  getOrderDatesForInvoice,
  getOrdersByDateForInvoice,
  getOrdersForInvoice,
  getInvoiceByOrder,
  saveInvoice,
  getAllInvoices,
  getProductsForStore,
  uploadReceipt,
  getVendorsForStore,
  deleteInvoice
} = require('../controllers/invoicesController');

// Multer — almacenar en memoria (buffer), límite 10MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  }
});

// GET  /api/invoices?storeId=X
router.get('/', getAllInvoices);

// GET  /api/invoices/order-dates?storeId=X
router.get('/order-dates', getOrderDatesForInvoice);

// GET  /api/invoices/orders-by-date?storeId=X&date=Y
router.get('/orders-by-date', getOrdersByDateForInvoice);

// GET  /api/invoices/orders?storeId=X
router.get('/orders', getOrdersForInvoice);

// GET  /api/invoices/by-order?orderId=X&storeId=Y
router.get('/by-order', getInvoiceByOrder);

// GET  /api/invoices/products?storeId=X
router.get('/products', getProductsForStore);

// POST /api/invoices/save
router.post('/save', saveInvoice);

// POST /api/invoices/upload-receipt  (multipart/form-data, campo: receipt)
router.post('/upload-receipt', upload.single('receipt'), uploadReceipt);

router.get('/vendors', getVendorsForStore);

router.delete('/delete', deleteInvoice);

module.exports = router;