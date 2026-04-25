const pool = require('../config/database');

// ============================================
// CATALOG — tipos de notificación disponibles
// Aquí se agregan futuros tipos sin tocar la BD
// ============================================
const NOTIFICATION_TYPES = [
  {
    notification_type: 'invoice_discrepancy',
    label:             'Invoice Discrepancy',
    description:       'Triggered when quantities or prices received differ from what was ordered',
    module:            'Invoices'
  }
  // Futuros tipos se agregan aquí:
  // { notification_type: 'low_stock', label: 'Low Stock Alert', description: '...', module: 'Inventory' },
];

// ============================================
// GET NOTIFICATION TYPES CATALOG
// ============================================
const getNotificationTypes = async (req, res) => {
  try {
    res.json({ success: true, data: NOTIFICATION_TYPES });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching notification types', error: error.message });
  }
};

// ============================================
// GET ALL NOTIFICATIONS FOR A STORE
// Retorna cada tipo con su estado (activo/inactivo) y sus destinatarios
// ============================================
const getNotificationsByStore = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    // Asegurar que existen registros para todos los tipos conocidos
    for (const type of NOTIFICATION_TYPES) {
      await pool.execute(
        `INSERT IGNORE INTO notification_settings (id_store, notification_type, label, description, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [storeId, type.notification_type, type.label, type.description]
      );
    }

    // Obtener settings con sus recipients
    const [settings] = await pool.execute(
      `SELECT 
        ns.id_notification,
        ns.notification_type,
        ns.label,
        ns.description,
        ns.is_active,
        ns.updated_at
       FROM notification_settings ns
       WHERE ns.id_store = ?
       ORDER BY ns.label ASC`,
      [storeId]
    );

    // Para cada setting, obtener sus recipients
    for (const setting of settings) {
      const [recipients] = await pool.execute(
        `SELECT 
          nr.id_recipient,
          u.id_users as id_user,
          u.name,
          u.email,
          u.role
         FROM notification_recipients nr
         INNER JOIN users u ON nr.id_user = u.id_users
         WHERE nr.id_notification = ?
         ORDER BY u.name ASC`,
        [setting.id_notification]
      );
      setting.recipients = recipients;

      // Enriquecer con info del catálogo
      const catalogEntry = NOTIFICATION_TYPES.find(t => t.notification_type === setting.notification_type);
      setting.module = catalogEntry?.module || 'General';
    }

    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Error fetching notifications', error: error.message });
  }
};

// ============================================
// TOGGLE ACTIVE STATUS
// ============================================
const toggleNotificationActive = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      'SELECT is_active FROM notification_settings WHERE id_notification = ?',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Notification not found' });

    const newStatus = rows[0].is_active ? 0 : 1;
    await pool.execute(
      'UPDATE notification_settings SET is_active = ? WHERE id_notification = ?',
      [newStatus, id]
    );

    res.json({
      success: true,
      message: `Notification ${newStatus ? 'enabled' : 'disabled'} successfully`,
      data: { is_active: newStatus }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error toggling notification', error: error.message });
  }
};

// ============================================
// GET USERS AVAILABLE FOR A STORE (para el picker)
// ============================================
const getUsersForStore = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const [users] = await pool.execute(
      `SELECT 
        u.id_users as id_user,
        u.name,
        u.email,
        u.role
       FROM users u
       INNER JOIN user_stores us ON u.id_users = us.id_user
       WHERE us.id_store = ?
       ORDER BY u.name ASC`,
      [storeId]
    );

    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching users for store', error: error.message });
  }
};

// ============================================
// UPDATE RECIPIENTS FOR A NOTIFICATION
// Reemplaza todos los recipients de un notification_setting
// ============================================
const updateRecipients = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;           // id_notification
    const { userIds = [] } = req.body;   // array de id_user

    // Verificar que existe el notification setting
    const [rows] = await connection.execute(
      'SELECT id_notification FROM notification_settings WHERE id_notification = ?',
      [id]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Notification setting not found' });
    }

    // Eliminar todos los recipients actuales
    await connection.execute(
      'DELETE FROM notification_recipients WHERE id_notification = ?',
      [id]
    );

    // Insertar nuevos recipients
    if (userIds.length > 0) {
      for (const userId of userIds) {
        await connection.execute(
          'INSERT INTO notification_recipients (id_notification, id_user) VALUES (?, ?)',
          [id, userId]
        );
      }
    }

    await connection.commit();

    // Retornar recipients actualizados
    const [recipients] = await pool.execute(
      `SELECT 
        nr.id_recipient,
        u.id_users as id_user,
        u.name,
        u.email,
        u.role
       FROM notification_recipients nr
       INNER JOIN users u ON nr.id_user = u.id_users
       WHERE nr.id_notification = ?
       ORDER BY u.name ASC`,
      [id]
    );

    res.json({
      success: true,
      message: 'Recipients updated successfully',
      data: recipients
    });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'Error updating recipients', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================
// GET RECIPIENTS FOR A NOTIFICATION TYPE
// Usado por otros módulos (ej: invoices) para saber a quién enviar
// ============================================
const getRecipientsForType = async (storeId, notificationType) => {
  try {
    const [recipients] = await pool.execute(
      `SELECT u.email, u.name
       FROM notification_recipients nr
       INNER JOIN notification_settings ns ON nr.id_notification = ns.id_notification
       INNER JOIN users u ON nr.id_user = u.id_users
       WHERE ns.id_store = ?
         AND ns.notification_type = ?
         AND ns.is_active = 1`,
      [storeId, notificationType]
    );
    return recipients;
  } catch (error) {
    console.error('Error fetching recipients for type:', error);
    return [];
  }
};

module.exports = {
  getNotificationTypes,
  getNotificationsByStore,
  toggleNotificationActive,
  getUsersForStore,
  updateRecipients,
  getRecipientsForType  // exportada para uso interno en otros controllers
};