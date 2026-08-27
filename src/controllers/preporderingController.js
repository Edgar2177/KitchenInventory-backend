const pool = require('../config/database');
const { sendPrepProductionEmail } = require('../services/emailService');

// ============================================================
// PRE-BATCH ORDERING
// Réplica de Ordering pero para preps: calcula cuánto preparar
// comparando el stock contado (inventario Locked) contra el
// Reorder Point / Par de cada prep, y envía la lista a cocina.
//
// Diferencias con Ordering (productos):
//  - Sin vendor, sin case_size, sin conversiones de peso.
//  - Los preps se cuentan en 'Each' → stock = SUM(quantity) directo.
//  - No persiste nada (solo calcula, muestra y envía por correo).
// ============================================================

// ------------------------------------------------------------
// Inventarios disponibles (fechas Locked) — igual que Ordering
// GET /prep-ordering/inventories?storeId=
// ------------------------------------------------------------
const getInventoriesForPrepOrdering = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ message: 'Store ID is required' });

    const [inventories] = await pool.execute(
      `SELECT 
        DATE(i.inventory_date) as inventory_date,
        MAX(i.id_inventories) as id_inventories,
        GROUP_CONCAT(DISTINCT l.location_name ORDER BY l.location_name SEPARATOR ', ') as location_name,
        SUM(i.total_ws_value) as total_ws_value,
        COUNT(DISTINCT ii.id_inventory_item) as product_count
      FROM inventories i
      LEFT JOIN locations l ON i.id_location = l.id_locations
      LEFT JOIN inventory_items ii ON i.id_inventories = ii.id_inventory
      WHERE i.id_store = ? AND i.status = 'Locked'
      GROUP BY DATE(i.inventory_date)
      ORDER BY DATE(i.inventory_date) DESC`,
      [storeId]
    );

    res.json({ success: true, data: inventories });
  } catch (error) {
    console.error('Error fetching inventories for prep ordering:', error);
    res.status(500).json({ message: 'Error fetching inventories', error: error.message });
  }
};

// ------------------------------------------------------------
// Calcular sugerencias de preparación
// POST /prep-ordering/calculate   { inventoryId, storeId }
// ------------------------------------------------------------
const calculatePrepSuggestions = async (req, res) => {
  try {
    const { inventoryId, storeId } = req.body;
    if (!inventoryId || !storeId) {
      return res.status(400).json({ message: 'Inventory ID and Store ID are required' });
    }

    // 1. Preps de la tienda con su par / reorder
    const [preps] = await pool.execute(
      `SELECT
        p.id_preps,
        p.prep_name,
        p.yield_unit,
        p.yield_quantity,
        p.par,
        p.reorder_point
      FROM preps p
      WHERE p.id_store = ?
      ORDER BY p.prep_name`,
      [storeId]
    );

    // 2. Stock contado del prep = SUMA de quantity en el inventario Locked
    //    de la fecha seleccionada (todas las locaciones: regular + physical).
    const [stockRows] = await pool.execute(
      `SELECT
        ii.id_prep,
        SUM(ii.quantity) as stock
      FROM inventory_items ii
      INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
      WHERE i.id_store = ?
        AND i.status = 'Locked'
        AND ii.item_type = 'prep'
        AND DATE(i.inventory_date) = (
          SELECT DATE(inventory_date) FROM inventories WHERE id_inventories = ?
        )
      GROUP BY ii.id_prep`,
      [storeId, inventoryId]
    );

    const stockMap = {};
    const countedPrepIds = new Set();
    stockRows.forEach(r => {
      stockMap[String(r.id_prep)] = parseFloat(r.stock) || 0;
      countedPrepIds.add(String(r.id_prep));
    });

    // 3. Armar la lista con la sugerencia
    const items = preps.map(p => {
      const key          = String(p.id_preps);
      const stockOnHand  = stockMap[key] !== undefined ? stockMap[key] : 0;
      const reorderPoint = parseFloat(p.reorder_point) || 0;
      const par          = parseFloat(p.par)           || 0;

      // Misma fórmula que Ordering: si stock <= reorder → preparar hasta el par
      let suggestedOrder = 0;
      if (par > 0 && stockOnHand <= reorderPoint) {
        suggestedOrder = Math.ceil(par - stockOnHand);
        if (suggestedOrder < 0) suggestedOrder = 0;
      }

      return {
        id_prep:                   p.id_preps,
        prep_name:                 p.prep_name,
        yield_unit:                p.yield_unit || '',
        reorder_point:             reorderPoint,
        par,
        stock_on_hand:             parseFloat(stockOnHand.toFixed(4)),
        suggested_order:           suggestedOrder,
        actual_order:              0,
        is_missing_from_inventory: !countedPrepIds.has(key),
        is_unconfigured:           (par === 0 && reorderPoint === 0)
      };
    });

    res.json({ success: true, data: { items } });
  } catch (error) {
    console.error('Error calculating prep suggestions:', error);
    res.status(500).json({ message: 'Error calculating prep suggestions', error: error.message });
  }
};

// ------------------------------------------------------------
// Enviar lista de preparación a cocina por correo
// POST /prep-ordering/send-email
//   { storeId, toEmail, cc, items: [{ prep_name, yield_unit, stock_on_hand, par, actual_order }] }
// ------------------------------------------------------------
const sendPrepEmail = async (req, res) => {
  try {
    const { storeId, toEmail, cc, items } = req.body;

    if (!toEmail)                     return res.status(400).json({ message: 'A destination email is required' });
    if (!items || items.length === 0) return res.status(400).json({ message: 'No items to send' });

    // Nombre de la tienda para el "from"
    let storeName = 'Kitchen';
    if (storeId) {
      const [[store]] = await pool.execute(
        'SELECT store_name FROM stores WHERE id_stores = ?',
        [storeId]
      );
      if (store?.store_name) storeName = store.store_name;
    }

    const result = await sendPrepProductionEmail({
      to:         toEmail,
      cc:         cc || undefined,
      store_name: storeName,
      items
    });

    res.json({ success: true, message: 'Preparation list sent successfully', messageId: result.messageId });
  } catch (error) {
    console.error('Error sending prep email:', error);
    res.status(500).json({ message: 'Error sending preparation list', error: error.message });
  }
};

module.exports = {
  getInventoriesForPrepOrdering,
  calculatePrepSuggestions,
  sendPrepEmail
};