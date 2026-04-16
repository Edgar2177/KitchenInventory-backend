const pool = require('../config/database');

// ========================================
// FUNCIÓN AUXILIAR
// Obtener o crear la location "Physical Inventory" para una tienda
// ========================================
const getOrCreatePhysicalLocation = async (connection, storeId) => {
  const [existing] = await connection.execute(
    `SELECT id_locations FROM locations 
     WHERE id_store = ? AND location_name = 'Physical Inventory'
     LIMIT 1`,
    [storeId]
  );
  if (existing.length > 0) return existing[0].id_locations;

  const [result] = await connection.execute(
    `INSERT INTO locations (id_store, location_name) VALUES (?, 'Physical Inventory')`,
    [storeId]
  );
  return result.insertId;
};

// ========================================
// OBTENER TODOS LOS PHYSICAL INVENTORIES
// ========================================
const getAllPhysicalInventories = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId es requerido' });

    const [inventories] = await pool.execute(
      `SELECT 
        i.id_inventories,
        i.inventory_date,
        i.status,
        i.total_ws_value,
        i.created_at,
        COUNT(DISTINCT ii.id_inventory_item) as total_products
       FROM inventories i
       INNER JOIN locations l ON i.id_location = l.id_locations
       LEFT JOIN inventory_items ii ON i.id_inventories = ii.id_inventory
       WHERE i.id_store = ?
         AND l.location_name = 'Physical Inventory'
       GROUP BY i.id_inventories
       ORDER BY i.inventory_date DESC`,
      [storeId]
    );

    res.json({ success: true, data: inventories });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al obtener los inventarios físicos', error: error.message });
  }
};

// ========================================
// OBTENER UN PHYSICAL INVENTORY POR ID
// ========================================
const getPhysicalInventoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const [inventory] = await pool.execute(
      `SELECT i.*, s.store_name, s.id_stores as storeId, l.location_name
       FROM inventories i
       INNER JOIN stores s ON i.id_store = s.id_stores
       INNER JOIN locations l ON i.id_location = l.id_locations
       WHERE i.id_inventories = ?`,
      [id]
    );

    if (inventory.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventario físico no encontrado' });
    }

    const inv           = inventory[0];
    const storeId       = inv.id_store;
    const inventoryDate = inv.inventory_date;

    // 1. Todos los productos del store ordenados por product type → categoría
    const [allProducts] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.container_type,
        p.wholesale_price,
        c.category_name,
        pt.product_name AS product_type_name
       FROM products p
       INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
       INNER JOIN categories c ON p.id_category = c.id_categories
       INNER JOIN product_types pt ON p.id_product_type = pt.id_product_types
       WHERE pbs.id_store = ?
       ORDER BY pt.product_name ASC, c.category_name ASC, p.product_name ASC`,
      [storeId]
    );

    // 2. Todos los preps del store
    const [allPreps] = await pool.execute(
      `SELECT 
        pr.id_preps,
        pr.prep_name as product_name,
        pr.yield_unit as container_unit,
        pr.yield_quantity as container_size,
        'prep' as item_type,
        'Pre-Batch' as category_name,
        'Pre-Batch' as product_type_name,
        0 as wholesale_price
       FROM preps pr
       WHERE pr.id_store = ?
       ORDER BY pr.prep_name ASC`,
      [storeId]
    );

    // 3. Cantidades guardadas en ESTE inventario — productos
    const [savedItems] = await pool.execute(
      `SELECT ii.id_product, ii.quantity as inv_quantity
       FROM inventory_items ii
       WHERE ii.id_inventory = ? AND ii.item_type = 'product'`,
      [id]
    );
    const savedMap = {};
    savedItems.forEach(item => { savedMap[item.id_product] = item.inv_quantity; });

    // 4. Cantidades guardadas en ESTE inventario — preps
    const [savedPrepItems] = await pool.execute(
      `SELECT ii.id_prep, ii.quantity as inv_quantity
       FROM inventory_items ii
       WHERE ii.id_inventory = ? AND ii.item_type = 'prep'`,
      [id]
    );
    const savedPrepMap = {};
    savedPrepItems.forEach(item => { savedPrepMap[item.id_prep] = item.inv_quantity; });

    // 5. Last Inv = SUMA del día más reciente ANTERIOR a este inventario (solo productos)
    const [lastInvData] = await pool.execute(
      `SELECT 
        ii.id_product,
        SUM(
          CASE
            WHEN ii.quantity_type IN ('Bottle', 'Can', 'Keg', 'Each', 'Box', 'Bag', 'Carton') THEN ii.quantity
            WHEN ii.quantity_type IN ('g', 'kg', 'oz', 'lb') THEN
              CASE
                WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight > 0
                THEN (ii.quantity - ii.empty_weight) / ii.net_weight
                ELSE 0
              END
            ELSE ii.quantity
          END
        ) as last_quantity
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       WHERE i.id_store = ?
         AND i.status = 'Locked'
         AND ii.item_type = 'product'
         AND DATE(i.inventory_date) = (
           SELECT DATE(i2.inventory_date)
           FROM inventories i2
           WHERE i2.id_store = ?
             AND i2.status = 'Locked'
             AND DATE(i2.inventory_date) < DATE(?)
             AND i2.id_inventories != ?
           ORDER BY i2.inventory_date DESC
           LIMIT 1
         )
       GROUP BY ii.id_product`,
      [storeId, storeId, inventoryDate, id]
    );

    const lastInvMap = {};
    lastInvData.forEach(item => { lastInvMap[item.id_product] = parseFloat(item.last_quantity) || 0; });

    // 6. Combinar productos
    const productItems = allProducts.map((p, i) => ({
      id_product:        p.id_products,
      id_preps:          null,
      item_type:         'product',
      product_name:      p.product_name,
      product_code:      p.product_code,
      category_name:     p.category_name,
      product_type_name: p.product_type_name || 'Other',
      wholesale_price:   p.wholesale_price || 0,
      container_size:    p.container_size  || null,
      container_unit:    p.container_unit  || '',
      container_type:    p.container_type  || '',
      last_inv_quantity: lastInvMap[p.id_products] ?? 0,
      inv_quantity:      savedMap[p.id_products]   ?? null,
      display_order:     i + 1
    }));

    // 7. Combinar preps
    const prepItems = allPreps.map((p, i) => ({
      id_product:        null,
      id_preps:          p.id_preps,
      item_type:         'prep',
      product_name:      p.product_name,
      product_code:      null,
      category_name:     'Pre-Batch',
      product_type_name: 'Pre-Batch',
      wholesale_price:   0,
      container_size:    p.container_size || null,
      container_unit:    p.container_unit || '',
      container_type:    'Each',
      last_inv_quantity: 0,
      inv_quantity:      savedPrepMap[p.id_preps] ?? null,
      display_order:     allProducts.length + i + 1
    }));

    res.json({ success: true, data: { ...inv, items: [...productItems, ...prepItems] } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al obtener el inventario físico', error: error.message });
  }
};

// ========================================
// OBTENER PRODUCTOS PARA PHYSICAL INVENTORY (crear nuevo)
// ========================================
const getProductsForPhysicalInventory = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId es requerido' });

    // Todos los productos del store ordenados por product type → categoría
    const [products] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name,
        p.product_code,
        p.wholesale_price,
        p.container_size,
        p.container_unit,
        p.container_type,
        c.category_name,
        c.id_categories,
        pt.product_name AS product_type_name,
        'product' as item_type
       FROM products p
       INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
       INNER JOIN categories c ON p.id_category = c.id_categories
       INNER JOIN product_types pt ON p.id_product_type = pt.id_product_types
       WHERE pbs.id_store = ?
       ORDER BY pt.product_name ASC, c.category_name ASC, p.product_name ASC`,
      [storeId]
    );

    // Todos los preps del store
    const [preps] = await pool.execute(
      `SELECT 
        pr.id_preps,
        pr.prep_name as product_name,
        pr.yield_unit as container_unit,
        pr.yield_quantity as container_size,
        'prep' as item_type,
        'Pre-Batch' as category_name,
        'Pre-Batch' as product_type_name,
        NULL as product_code,
        0 as wholesale_price
       FROM preps pr
       WHERE pr.id_store = ?
       ORDER BY pr.prep_name ASC`,
      [storeId]
    );

    if (products.length === 0 && preps.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Last Inv = SUMA del día más reciente (solo productos)
    const [lastInvData] = await pool.execute(
      `SELECT 
        ii.id_product,
        SUM(
          CASE
            WHEN ii.quantity_type IN ('Bottle', 'Can', 'Keg', 'Each', 'Box', 'Bag', 'Carton') THEN ii.quantity
            WHEN ii.quantity_type IN ('g', 'kg', 'oz', 'lb') THEN
              CASE
                WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight > 0
                THEN (ii.quantity - ii.empty_weight) / ii.net_weight
                ELSE 0
              END
            ELSE ii.quantity
          END
        ) as last_quantity
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       WHERE i.id_store = ?
         AND i.status = 'Locked'
         AND ii.item_type = 'product'
         AND DATE(i.inventory_date) = (
           SELECT DATE(i2.inventory_date)
           FROM inventories i2
           WHERE i2.id_store = ?
             AND i2.status = 'Locked'
           ORDER BY i2.inventory_date DESC
           LIMIT 1
         )
       GROUP BY ii.id_product`,
      [storeId, storeId]
    );

    const lastInvMap = {};
    lastInvData.forEach(item => { lastInvMap[item.id_product] = parseFloat(item.last_quantity) || 0; });

    const productResults = products.map(p => ({
      ...p,
      id_preps:          null,
      product_type_name: p.product_type_name || 'Other',
      last_inv_quantity: lastInvMap[p.id_products] ?? 0
    }));

    const prepResults = preps.map(p => ({
      ...p,
      id_products:       null,
      product_type_name: 'Pre-Batch',
      last_inv_quantity: 0
    }));

    res.json({ success: true, data: [...productResults, ...prepResults] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error retrieving products for physical inventory', error: error.message });
  }
};

// ========================================
// CREAR PHYSICAL INVENTORY
// ========================================
const createPhysicalInventory = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { storeId, inventoryDate, status = 'Unlocked', items = [] } = req.body;
    if (!storeId || !inventoryDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'storeId e inventoryDate son requeridos' });
    }

    const locationId = await getOrCreatePhysicalLocation(connection, storeId);

    let totalWs = 0;
    items.forEach(item => {
      const qty   = parseFloat(item.inv_quantity)   || 0;
      const price = parseFloat(item.wholesale_price) || 0;
      totalWs += qty * price;
    });

    const [result] = await connection.execute(
      `INSERT INTO inventories (id_store, id_location, inventory_type, inventory_date, status, total_ws_value, total_losses_value)
       VALUES (?, ?, 'Standard', ?, ?, ?, 0)`,
      [storeId, locationId, inventoryDate, status, totalWs]
    );
    const inventoryId = result.insertId;

    let displayOrder = 1;
    for (const item of items) {
      const qty   = parseFloat(item.inv_quantity)   || 0;
      const price = parseFloat(item.wholesale_price) || 0;
      if (qty > 0) {
        if (item.item_type === 'prep') {
          await connection.execute(
            `INSERT INTO inventory_items 
              (id_inventory, id_product, id_prep, item_type, id_location, display_order, quantity_type, quantity, wholesale_value)
             VALUES (?, NULL, ?, 'prep', ?, ?, 'Each', ?, ?)`,
            [inventoryId, item.id_preps, locationId, displayOrder, qty, qty * price]
          );
        } else {
          await connection.execute(
            `INSERT INTO inventory_items 
              (id_inventory, id_product, id_prep, item_type, id_location, display_order, quantity_type, quantity, wholesale_value)
             VALUES (?, ?, NULL, 'product', ?, ?, 'Each', ?, ?)`,
            [inventoryId, item.id_products, locationId, displayOrder, qty, qty * price]
          );
        }
        displayOrder++;
      }
    }

    await connection.execute(
      `UPDATE inventories SET total_ws_value = ? WHERE id_inventories = ?`,
      [totalWs, inventoryId]
    );

    await connection.commit();
    res.status(201).json({
      success: true,
      message: 'Inventario físico creado exitosamente',
      data: { id: inventoryId, totalWs }
    });
  } catch (error) {
    await connection.rollback();
    console.error('❌ ERROR in createPhysicalInventory:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear el inventario físico', error: error.message });
  } finally {
    connection.release();
  }
};

// ========================================
// ACTUALIZAR PHYSICAL INVENTORY
// ========================================
const updatePhysicalInventory = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id }                                = req.params;
    const { inventoryDate, status, items = [] } = req.body;

    const [inventory] = await connection.execute(
      `SELECT i.status, i.id_store, i.id_location 
       FROM inventories i
       INNER JOIN locations l ON i.id_location = l.id_locations
       WHERE i.id_inventories = ? AND l.location_name = 'Physical Inventory'`,
      [id]
    );

    if (inventory.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Inventario físico no encontrado' });
    }

    if (inventory[0].status === 'Locked' && status !== 'Unlocked') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No se puede editar un inventario bloqueado' });
    }

    const locationId = inventory[0].id_location;

    let totalWs = 0;
    items.forEach(item => {
      const qty   = parseFloat(item.inv_quantity)   || 0;
      const price = parseFloat(item.wholesale_price) || 0;
      totalWs += qty * price;
    });

    const updates = [];
    const params  = [];
    if (inventoryDate) { updates.push('inventory_date = ?'); params.push(inventoryDate); }
    if (status)        { updates.push('status = ?');         params.push(status); }
    updates.push('total_ws_value = ?');
    params.push(totalWs);
    params.push(id);

    await connection.execute(
      `UPDATE inventories SET ${updates.join(', ')} WHERE id_inventories = ?`,
      params
    );

    await connection.execute('DELETE FROM inventory_items WHERE id_inventory = ?', [id]);

    let displayOrder = 1;
    for (const item of items) {
      const qty   = parseFloat(item.inv_quantity)   || 0;
      const price = parseFloat(item.wholesale_price) || 0;
      if (qty > 0) {
        if (item.item_type === 'prep') {
          await connection.execute(
            `INSERT INTO inventory_items 
              (id_inventory, id_product, id_prep, item_type, id_location, display_order, quantity_type, quantity, wholesale_value)
             VALUES (?, NULL, ?, 'prep', ?, ?, 'Each', ?, ?)`,
            [id, item.id_preps, locationId, displayOrder, qty, qty * price]
          );
        } else {
          await connection.execute(
            `INSERT INTO inventory_items 
              (id_inventory, id_product, id_prep, item_type, id_location, display_order, quantity_type, quantity, wholesale_value)
             VALUES (?, ?, NULL, 'product', ?, ?, 'Each', ?, ?)`,
            [id, item.id_products, locationId, displayOrder, qty, qty * price]
          );
        }
        displayOrder++;
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Inventario físico actualizado exitosamente' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'Error al actualizar el inventario físico', error: error.message });
  } finally {
    connection.release();
  }
};

// ========================================
// TOGGLE LOCK
// ========================================
const toggleLockPhysicalInventory = async (req, res) => {
  try {
    const { id } = req.params;

    const [inventory] = await pool.execute(
      `SELECT i.status FROM inventories i
       INNER JOIN locations l ON i.id_location = l.id_locations
       WHERE i.id_inventories = ? AND l.location_name = 'Physical Inventory'`,
      [id]
    );

    if (inventory.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventario físico no encontrado' });
    }

    const newStatus = inventory[0].status === 'Locked' ? 'Unlocked' : 'Locked';
    await pool.execute('UPDATE inventories SET status = ? WHERE id_inventories = ?', [newStatus, id]);

    res.json({
      success: true,
      message: `Inventario ${newStatus === 'Locked' ? 'bloqueado' : 'desbloqueado'} exitosamente`,
      data: { status: newStatus }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al cambiar el estado', error: error.message });
  }
};

// ========================================
// ELIMINAR PHYSICAL INVENTORY
// ========================================
const deletePhysicalInventory = async (req, res) => {
  try {
    const { id } = req.params;

    const [inventory] = await pool.execute(
      `SELECT i.status FROM inventories i
       INNER JOIN locations l ON i.id_location = l.id_locations
       WHERE i.id_inventories = ? AND l.location_name = 'Physical Inventory'`,
      [id]
    );

    if (inventory.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventario físico no encontrado' });
    }

    if (inventory[0].status === 'Locked') {
      return res.status(400).json({ success: false, message: 'No se puede eliminar un inventario bloqueado' });
    }

    await pool.execute('DELETE FROM inventories WHERE id_inventories = ?', [id]);
    res.json({ success: true, message: 'Inventario físico eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al eliminar el inventario físico', error: error.message });
  }
};

module.exports = {
  getAllPhysicalInventories,
  getPhysicalInventoryById,
  getProductsForPhysicalInventory,
  createPhysicalInventory,
  updatePhysicalInventory,
  toggleLockPhysicalInventory,
  deletePhysicalInventory
};