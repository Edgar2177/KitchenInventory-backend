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
        AND p.show_in_physical_inventory = 1
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
    const { storeId, inventoryId, toEmail, cc, items } = req.body;

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

    // 1) Enviar el correo PRIMERO. Si falla, no guardamos nada.
    const result = await sendPrepProductionEmail({
      to:         toEmail,
      cc:         cc || undefined,
      store_name: storeName,
      items
    });

    // 2) El correo salió bien → persistir la orden de preparación.
    //    Si el guardado fallara, el correo YA se envió: devolvemos éxito
    //    igualmente y dejamos aviso en el log (no re-enviar).
    let orderNumber = null;
    try {
      orderNumber = await persistPrepOrder({ storeId, inventoryId, toEmail, cc, items });
    } catch (persistErr) {
      console.error('Prep email sent but order was not saved:', persistErr.message);
    }

    res.json({
      success: true,
      message: 'Preparation list sent successfully',
      messageId: result.messageId,
      order_number: orderNumber
    });
  } catch (error) {
    console.error('Error sending prep email:', error);
    res.status(500).json({ message: 'Error sending preparation list', error: error.message });
  }
};

// ------------------------------------------------------------
// HELPER: generar el siguiente PREP-YYYY-NNN (global, a prueba de duplicados)
// Mismo criterio que arreglamos en Ordering: MAX del correlativo real.
// ------------------------------------------------------------
const nextPrepOrderSeq = async (connection) => {
  const year = new Date().getFullYear();
  const [[row]] = await connection.execute(
    `SELECT MAX(CAST(SUBSTRING_INDEX(order_number, '-', -1) AS UNSIGNED)) AS maxNum
     FROM prep_orders
     WHERE order_number LIKE ?`,
    [`PREP-${year}-%`]
  );
  const maxNum = row && row.maxNum ? parseInt(row.maxNum) : 0;
  return maxNum + 1;
};

// ------------------------------------------------------------
// HELPER: guardar la orden + items en una transacción.
// Devuelve el order_number generado.
// ------------------------------------------------------------
const persistPrepOrder = async ({ storeId, inventoryId, toEmail, cc, items }) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const year = new Date().getFullYear();
    let nextNum = await nextPrepOrderSeq(connection);
    let orderNumber = null;
    let orderId = null;

    // Insertar cabecera con reintento por si el correlativo choca (carrera)
    for (let attempt = 0; attempt < 50; attempt++) {
      orderNumber = `PREP-${year}-${String(nextNum).padStart(3, '0')}`;
      try {
        const [r] = await connection.execute(
          `INSERT INTO prep_orders
             (id_store, order_number, id_inventory, sent_to, sent_cc, sent_at, total_items)
           VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
          [storeId, orderNumber, inventoryId || null, toEmail, cc || null, items.length]
        );
        orderId = r.insertId;
        break;
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') { nextNum++; continue; }
        throw err;
      }
    }
    if (orderId === null) throw new Error('Could not generate a unique prep order number');

    // Insertar items (nombre "congelado")
    for (const it of items) {
      const qty = (it.actual_order !== undefined && it.actual_order !== null && it.actual_order !== '')
        ? parseFloat(it.actual_order) : parseFloat(it.suggested_order) || 0;
      await connection.execute(
        `INSERT INTO prep_order_items (id_prep_order, id_prep, prep_name, quantity, unit)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, it.id_prep || null, it.prep_name, qty, it.yield_unit || null]
      );
    }

    await connection.commit();
    return orderNumber;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// ------------------------------------------------------------
// Fechas disponibles de órdenes de preparación (para el filtro)
// GET /prep-ordering/view/dates?storeId=
// ------------------------------------------------------------
const getPrepOrderDates = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ message: 'Store ID is required' });

    const [dates] = await pool.execute(
      `SELECT
         DATE(sent_at) AS date,
         COUNT(*)      AS order_count
       FROM prep_orders
       WHERE id_store = ? AND sent_at IS NOT NULL
       GROUP BY DATE(sent_at)
       ORDER BY DATE(sent_at) DESC`,
      [storeId]
    );

    res.json({ success: true, data: dates });
  } catch (error) {
    console.error('Error fetching prep order dates:', error);
    res.status(500).json({ message: 'Error fetching prep order dates', error: error.message });
  }
};

// ------------------------------------------------------------
// Órdenes de preparación de una fecha (con sus items)
// GET /prep-ordering/view?storeId=&filterDate=
// ------------------------------------------------------------
const getPrepOrdersForView = async (req, res) => {
  try {
    const { storeId, filterDate } = req.query;
    if (!storeId || !filterDate) {
      return res.status(400).json({ message: 'Store ID and date are required' });
    }

    const [orders] = await pool.execute(
      `SELECT
         id_prep_order AS id_prep_order,
         order_number,
         id_inventory,
         sent_to,
         sent_cc,
         sent_at,
         total_items
       FROM prep_orders
       WHERE id_store = ? AND DATE(sent_at) = ?
       ORDER BY sent_at DESC, id_prep_order DESC`,
      [storeId, filterDate]
    );

    if (orders.length === 0) {
      return res.json({ success: true, orders: [] });
    }

    const ids = orders.map(o => o.id_prep_order);
    const placeholders = ids.map(() => '?').join(',');
    const [items] = await pool.execute(
      `SELECT id_prep_order, id_prep, prep_name, quantity, unit
       FROM prep_order_items
       WHERE id_prep_order IN (${placeholders})
       ORDER BY id_prep_order_item ASC`,
      ids
    );

    const itemsByOrder = {};
    items.forEach(it => {
      const k = String(it.id_prep_order);
      if (!itemsByOrder[k]) itemsByOrder[k] = [];
      itemsByOrder[k].push(it);
    });

    const withItems = orders.map(o => ({
      ...o,
      items: itemsByOrder[String(o.id_prep_order)] || []
    }));

    res.json({ success: true, orders: withItems });
  } catch (error) {
    console.error('Error fetching prep orders:', error);
    res.status(500).json({ message: 'Error fetching prep orders', error: error.message });
  }
};

// ------------------------------------------------------------
// Eliminar una orden de preparación (items se van por ON DELETE CASCADE)
// DELETE /prep-ordering/view/:id
// ------------------------------------------------------------
const deletePrepOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute(
      'DELETE FROM prep_orders WHERE id_prep_order = ?',
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Prep order not found' });
    }
    res.json({ success: true, message: 'Prep order deleted successfully' });
  } catch (error) {
    console.error('Error deleting prep order:', error);
    res.status(500).json({ message: 'Error deleting prep order', error: error.message });
  }
};

module.exports = {
  getInventoriesForPrepOrdering,
  calculatePrepSuggestions,
  sendPrepEmail,
  getPrepOrderDates,
  getPrepOrdersForView,
  deletePrepOrder
};