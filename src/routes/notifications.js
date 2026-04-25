const express = require('express');
const router  = express.Router();
const {
  getNotificationTypes,
  getNotificationsByStore,
  toggleNotificationActive,
  getUsersForStore,
  updateRecipients
} = require('../controllers/notificationsController');

// GET  /api/notifications/types              → catálogo de tipos
router.get('/types', getNotificationTypes);

// GET  /api/notifications?storeId=X          → settings + recipients por store
router.get('/', getNotificationsByStore);

// GET  /api/notifications/users?storeId=X    → usuarios disponibles del store
router.get('/users', getUsersForStore);

// PATCH /api/notifications/:id/toggle        → activar / desactivar
router.patch('/:id/toggle', toggleNotificationActive);

// PUT  /api/notifications/:id/recipients     → reemplazar destinatarios
router.put('/:id/recipients', updateRecipients);

module.exports = router;