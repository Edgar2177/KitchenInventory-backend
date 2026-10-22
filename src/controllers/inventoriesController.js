const pool = require('../config/database');
const XLSX = require('xlsx');

// ========================================
// FUNCIONES AUXILIARES
// ========================================

// Devuelve el id del inventario ABIERTO más reciente de una location
// (cualquier estado distinto de 'Locked'), o null si no hay ninguno.
const checkActiveInventory = async (locationId, excludeInventoryId = null) => {
  let query = `
    SELECT id_inventories
    FROM inventories
    WHERE id_location = ? AND status != 'Locked'
  `;
  const params = [locationId];
  if (excludeInventoryId) {
    query += ' AND id_inventories != ?';
    params.push(excludeInventoryId);
  }
  query += ' ORDER BY id_inventories DESC LIMIT 1';
  const [result] = await pool.execute(query, params);
  return result.length > 0 ? result[0].id_inventories : null;
};

const getLastInventoryOrder = async (locationId) => {
  const [result] = await pool.execute(
    `SELECT ii.id_product, ii.id_prep, ii.item_type, ii.display_order
     FROM inventory_items ii
     INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
     WHERE i.id_location = ?
       AND i.id_inventories = (
         SELECT MAX(id_inventories) FROM inventories WHERE id_location = ?
       )
     ORDER BY ii.display_order`,
    [locationId, locationId]
  );
  return result;
};

const calculateNetWeight = async (connection, productId, itemFullWeight, itemEmptyWeight) => {
  const [product] = await connection.execute(
    `SELECT full_weight_base_unit as full_weight,
            empty_weight_base_unit as empty_weight
     FROM products WHERE id_products = ?`,
    [productId]
  );

  let fullWeight  = null;
  let emptyWeight = null;

  if (product.length > 0) {
    fullWeight  = product[0].full_weight  != null ? parseFloat(product[0].full_weight)  : null;
    emptyWeight = product[0].empty_weight != null ? parseFloat(product[0].empty_weight) : null;
  }

  if (fullWeight === null && itemFullWeight) {
    fullWeight = parseFloat(itemFullWeight) || null;
  }
  if (emptyWeight === null && itemEmptyWeight != null && itemEmptyWeight !== '') {
    emptyWeight = parseFloat(itemEmptyWeight) ?? null;
  }

  if (fullWeight && emptyWeight !== null && fullWeight > emptyWeight) {
    return { fullWeight, emptyWeight, netWeight: fullWeight - emptyWeight };
  }

  return { fullWeight: fullWeight || null, emptyWeight: emptyWeight ?? null, netWeight: null };
};

// ========================================
// HELPERS DE CONVERSIÓN
// ========================================
const GRAMS = {
  g: 1, kg: 1000, oz: 28.3495, lb: 453.592,
  ml: 1, L: 1000, Liter: 1000, Gallon: 3785.41, 'fl oz': 29.5735
};

const COUNT_UNITS  = ['Bottle', 'Keg', 'Can', 'Each', 'Box', 'Bag', 'Carton'];
const VOLUME_UNITS = ['ml', 'L', 'Liter', 'Gallon', 'fl oz'];
const WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb'];

const calcProductWeight = (quantity, quantityType, fullWeight, emptyWeight, netWeight) => {
  const qty = parseFloat(quantity) || 0;

  if (COUNT_UNITS.includes(quantityType)) {
    return { product_weight: qty, product_weight_grams: qty, product_weight_unit: 'unit' };
  }

  const isWeightOrVolume = WEIGHT_UNITS.includes(quantityType) || VOLUME_UNITS.includes(quantityType);

  if (isWeightOrVolume) {
    const qtyInGrams = qty * (GRAMS[quantityType] || 1);
    const baseUnit   = VOLUME_UNITS.includes(quantityType) ? 'ml' : 'g';
    const emptyVal   = (emptyWeight !== null && emptyWeight !== undefined) ? parseFloat(emptyWeight) : 0;
    const netVal     = parseFloat(netWeight) || 0;
    const fullVal    = parseFloat(fullWeight) || 0;

    if (netVal > 0 && fullVal > 0 && emptyVal > 0) {
      const productWeightGrams = qtyInGrams - emptyVal;
      return {
        product_weight:       parseFloat(productWeightGrams.toFixed(4)),
        product_weight_grams: parseFloat(productWeightGrams.toFixed(4)),
        product_weight_unit:  baseUnit
      };
    } else {
      return {
        product_weight:       qty,
        product_weight_grams: parseFloat(qtyInGrams.toFixed(4)),
        product_weight_unit:  baseUnit
      };
    }
  }

  return { product_weight: qty, product_weight_grams: qty, product_weight_unit: 'unit' };
};

// ========================================
// CALCULAR WHOLESALE VALUE DE UN PREP
// ========================================
const calcPrepWholesaleValue = (quantity, quantityType, yieldQuantity, yieldUnit, totalCost) => {
  const qty       = parseFloat(quantity)      || 0;
  const yieldQty  = parseFloat(yieldQuantity) || 0;
  const cost      = parseFloat(totalCost)     || 0;

  if (qty <= 0 || yieldQty <= 0 || cost <= 0) return 0;

  if (quantityType === yieldUnit) {
    return (cost / yieldQty) * qty;
  }

  const qtyBase   = qty      * (GRAMS[quantityType] || 1);
  const yieldBase = yieldQty * (GRAMS[yieldUnit]    || 1);

  if (yieldBase <= 0) return 0;

  return (cost / yieldBase) * qtyBase;
};

const validateInventoryItems = (items) => {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.quantity === null || item.quantity === undefined || item.quantity === '') {
      return {
        valid: false,
        message: `Please enter a quantity for ${item.productName || item.prepName || 'item ' + (i + 1)}`
      };
    }
  }
  return { valid: true };
};

// ========================================
// AUTO-CREAR LOCATION "From Excel" POR STORE
// ========================================
const getOrCreateFromExcelLocation = async (storeId) => {
  const [existing] = await pool.execute(
    `SELECT id_locations FROM locations 
     WHERE LOWER(TRIM(location_name)) = 'from excel' AND id_store = ?`,
    [storeId]
  );
  if (existing.length > 0) return existing[0].id_locations;
  const [result] = await pool.execute(
    `INSERT INTO locations (location_name, id_store) VALUES ('From Excel', ?)`,
    [storeId]
  );
  return result.insertId;
};

// ========================================
// HELPER: Lectura de columnas flexible (case-insensitive)
// ========================================
const getRowValue = (row, ...names) => {
  for (const name of names) {
    const normalized = name.toLowerCase().trim();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase().trim() === normalized) {
        const val = row[key];
        return (val !== null && val !== undefined) ? String(val).trim() : null;
      }
    }
  }
  return null;
};

// ========================================
// CONTROLADORES
// ========================================

const getAllInventories = async (req, res) => {
  try {
    const { storeId } = req.query;
    let query = `
      SELECT 
        i.id_inventories,
        i.inventory_type,
        i.inventory_date,
        i.status,
        i.id_location,
        l.location_name,
        i.total_ws_value,
        i.total_losses_value,
        i.created_at,
        s.store_name,
        COUNT(DISTINCT ii.id_inventory_item) as total_products,
        COUNT(DISTINCT il.id_inventory_loss) as total_losses
      FROM inventories i
      INNER JOIN stores s ON i.id_store = s.id_stores
      LEFT JOIN locations l ON i.id_location = l.id_locations
      LEFT JOIN inventory_items ii ON i.id_inventories = ii.id_inventory
      LEFT JOIN inventory_losses il ON i.id_inventories = il.id_inventory
      WHERE 1=1
    `;
    const params = [];
    if (storeId) { query += ' AND i.id_store = ?'; params.push(storeId); }
    query += ' GROUP BY i.id_inventories ORDER BY i.inventory_date DESC';
    const [inventories] = await pool.execute(query, params);
    res.json({ success: true, data: inventories });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching inventories', error: error.message });
  }
};

const getInventoryById = async (req, res) => {
  try {
    const { id } = req.params;
    const [inventory] = await pool.execute(
      `SELECT i.*, s.store_name, l.location_name
       FROM inventories i
       INNER JOIN stores s ON i.id_store = s.id_stores
       LEFT JOIN locations l ON i.id_location = l.id_locations
       WHERE i.id_inventories = ?`,
      [id]
    );
    if (inventory.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }

    const [items] = await pool.execute(
      `SELECT 
        ii.*,
        p.product_name,
        p.product_code,
        p.container_type,
        p.container_size,
        p.container_unit,
        p.case_size,
        p.full_weight_base_unit  as product_full_weight,
        p.empty_weight_base_unit as product_empty_weight,
        p.wholesale_price,
        l.location_name,
        c.category_name,
        pt.product_name AS product_type_name
       FROM inventory_items ii
       INNER JOIN products p ON ii.id_product = p.id_products
       LEFT JOIN categories c ON p.id_category = c.id_categories
       LEFT JOIN product_types pt ON p.id_product_type = pt.id_product_types
       LEFT JOIN locations l ON ii.id_location = l.id_locations
       WHERE ii.id_inventory = ? AND ii.item_type = 'product'
       ORDER BY ii.display_order ASC, p.product_name`,
      [id]
    );

    const [prepItems] = await pool.execute(
      `SELECT 
        ii.*,
        pr.prep_name,
        pr.yield_quantity,
        pr.yield_unit,
        pr.yield_unit_cost,
        pr.total_cost as prep_total_cost,
        l.location_name
       FROM inventory_items ii
       INNER JOIN preps pr ON ii.id_prep = pr.id_preps
       LEFT JOIN locations l ON ii.id_location = l.id_locations
       WHERE ii.id_inventory = ? AND ii.item_type = 'prep'
       ORDER BY ii.display_order ASC, pr.prep_name`,
      [id]
    );

    const [losses] = await pool.execute(
      `SELECT il.*, p.product_name, p.product_code
       FROM inventory_losses il
       INNER JOIN products p ON il.id_product = p.id_products
       WHERE il.id_inventory = ?
       ORDER BY il.created_at DESC`,
      [id]
    );

    res.json({ success: true, data: { ...inventory[0], items, prepItems, losses } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching inventory', error: error.message });
  }
};

const getAvailableProducts = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId es requerido' });
    }

    const [products] = await pool.execute(
      `SELECT 
        p.id_products as id,
        p.product_name as name,
        p.product_code,
        p.container_type,
        p.container_size,
        p.container_unit,
        p.container_size_base_unit,
        p.container_size_base_unit_type,
        p.case_size,
        p.wholesale_price,
        p.full_weight_base_unit  as full_weight,
        p.empty_weight_base_unit as empty_weight,
        p.full_weight_unit as weight_unit,
        pbs.par,
        pbs.reorder_point,
        pbs.order_by_the,
        c.category_name,
        pt.product_name AS product_type_name
       FROM products p
       INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
       LEFT JOIN categories c ON p.id_category = c.id_categories
       LEFT JOIN product_types pt ON p.id_product_type = pt.id_product_types
       WHERE pbs.id_store = ?
       ORDER BY p.product_name`,
      [storeId]
    );

    const [preps] = await pool.execute(
      `SELECT
        id_preps as id,
        prep_name as name,
        total_cost,
        yield_quantity,
        yield_unit,
        yield_unit_cost
       FROM preps
       WHERE id_store = ?
         AND show_in_physical_inventory = 1
       ORDER BY prep_name`,
      [storeId]
    );

    // Last Inv por producto = SUMA del día Locked más reciente de TODA la tienda
    // (misma definición que usa Physical Inventory). Las cantidades por peso/volumen
    // se convierten a "contenedores" igual que en getProductsForPrintInventory.
    const [lastInvRows] = await pool.execute(
      `SELECT
         ii.id_product,
         ROUND(SUM(
           CASE
             WHEN ii.quantity_type IN ('Bottle', 'Can', 'Keg', 'Each', 'Box', 'Bag', 'Carton') THEN ii.quantity
             WHEN ii.quantity_type IN ('g', 'kg', 'oz', 'lb', 'ml', 'L', 'Liter', 'Gallon', 'fl oz') THEN
               CASE
                 WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight IS NOT NULL AND ii.empty_weight > 0 THEN
                   (CASE ii.quantity_type
                     WHEN 'kg' THEN ii.quantity * 1000 WHEN 'oz' THEN ii.quantity * 28.3495
                     WHEN 'lb' THEN ii.quantity * 453.592 WHEN 'L' THEN ii.quantity * 1000
                     WHEN 'Liter' THEN ii.quantity * 1000 WHEN 'Gallon' THEN ii.quantity * 3785.41
                     WHEN 'fl oz' THEN ii.quantity * 29.5735 ELSE ii.quantity END
                     - ii.empty_weight) / ii.net_weight
                 ELSE ii.product_weight_grams / NULLIF(p.container_size_base_unit, 0)
               END
             ELSE ii.quantity
           END
         ), 2) AS last_quantity
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       INNER JOIN products p    ON ii.id_product   = p.id_products
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
    lastInvRows.forEach(r => { lastInvMap[r.id_product] = parseFloat(r.last_quantity) || 0; });

    const productsWithLastInv = products.map(p => ({
      ...p,
      last_inv_quantity: lastInvMap[p.id] ?? 0
    }));

    res.json({ success: true, data: productsWithLastInv, preps });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching available products', error: error.message });
  }
};

const createInventory = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { storeId, locationId, inventoryDate, items, prepItems = [], waste = [] } = req.body;

    if (!storeId || !inventoryDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Store and date are required' });
    }

    const status = req.body.status || 'Open';
    if (status === 'Locked' && (!items || items.length === 0) && prepItems.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please add at least one product or prep before closing the inventory' });
    }

    if (!locationId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Location is required' });
    }

    // Regla de negocio: una location no puede tener más de un inventario abierto
    // (no cerrado) a la vez. Esta verificación aplica a CUALQUIER creación nueva
    // —borrador o cierre— para evitar inventarios duplicados de la misma fecha.
    // Para continuar un inventario existente se usa updateInventory, no este endpoint.
    const activeInventoryId = await checkActiveInventory(locationId);
    if (activeInventoryId) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        code: 'ACTIVE_INVENTORY_EXISTS',
        activeInventoryId,
        message: 'There is already an open inventory for this location. Please continue or close it before creating a new one.'
      });
    }

    let finalItems = [];
    if (items && items.length > 0) {
      if (status === 'Locked') {
        const validation = validateInventoryItems(items);
        if (!validation.valid) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: validation.message });
        }
      }

      const lastOrder  = await getLastInventoryOrder(locationId);
      const orderMap   = new Map();
      lastOrder.filter(i => i.item_type === 'product').forEach(item => orderMap.set(item.id_product, item.display_order));

      const orderedItems = [];
      const newProducts  = [];
      items.forEach(item => {
        if (orderMap.has(item.productId)) {
          orderedItems.push({ ...item, order: orderMap.get(item.productId) });
        } else {
          newProducts.push(item);
        }
      });
      orderedItems.sort((a, b) => a.order - b.order);

      let currentOrder = 1;
      finalItems = [
        ...newProducts.map(item  => ({ ...item, order: currentOrder++ })),
        ...orderedItems.map(item => ({ ...item, order: currentOrder++ }))
      ];
    }

    let finalPrepItems = [];
    if (prepItems && prepItems.length > 0) {
      if (status === 'Locked') {
        const validation = validateInventoryItems(prepItems);
        if (!validation.valid) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: validation.message });
        }
      }
      const baseOrder = finalItems.length + 1;
      finalPrepItems = prepItems.map((item, idx) => ({ ...item, order: baseOrder + idx }));
    }

    const [result] = await connection.execute(
      `INSERT INTO inventories (id_store, id_location, inventory_type, inventory_date, status, total_ws_value, total_losses_value)
       VALUES (?, ?, 'Standard', ?, ?, 0, 0)`,
      [storeId, locationId, inventoryDate, status]
    );
    const inventoryId = result.insertId;

    let totalWsValue = 0;

    for (const item of finalItems) {
      const quantity = parseFloat(item.quantity);
      if (isNaN(quantity)) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: `Invalid quantity for product: ${item.productName}` });
      }
      const wsValue = parseFloat(item.wholesaleValue) || 0;
      const weights = await calculateNetWeight(connection, item.productId, item.fullWeight, item.emptyWeight);
      const pw      = calcProductWeight(quantity, item.quantityType, weights.fullWeight, weights.emptyWeight, weights.netWeight);

      await connection.execute(
        `INSERT INTO inventory_items (
          id_inventory, id_product, id_prep, item_type, id_location, display_order,
          quantity_type, quantity, case_size,
          full_weight, empty_weight, net_weight,
          product_weight, product_weight_grams, product_weight_unit,
          wholesale_value
        ) VALUES (?, ?, NULL, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inventoryId, item.productId, item.locationId || null, item.order,
          item.quantityType, quantity, item.caseSize ? parseInt(item.caseSize) : null,
          weights.fullWeight, weights.emptyWeight, weights.netWeight,
          pw.product_weight, pw.product_weight_grams, pw.product_weight_unit,
          wsValue
        ]
      );
      totalWsValue += wsValue;
    }

    for (const item of finalPrepItems) {
      const quantity = parseFloat(item.quantity);
      if (isNaN(quantity)) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: `Invalid quantity for prep: ${item.prepName}` });
      }

      const wsValue = parseFloat(item.wholesaleValue) || 0;

      await connection.execute(
        `INSERT INTO inventory_items (
          id_inventory, id_product, id_prep, item_type, id_location, display_order,
          quantity_type, quantity, case_size,
          full_weight, empty_weight, net_weight,
          product_weight, product_weight_grams, product_weight_unit,
          wholesale_value
        ) VALUES (?, NULL, ?, 'prep', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        [
          inventoryId,
          item.prepId,
          item.locationId || null,
          item.order,
          item.quantityType,
          quantity,
          quantity,
          quantity,
          item.quantityType,
          wsValue
        ]
      );
      totalWsValue += wsValue;
    }

    let totalWasteValue = 0;
    for (const w of waste) {
      const wsValue = parseFloat(w.wholesaleValue) || 0;
      await connection.execute(
        `INSERT INTO inventory_losses (id_inventory, id_product, quantity, unit, reason, loss_value)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [inventoryId, w.productId, parseFloat(w.quantity), w.quantityType || 'units', '', wsValue]
      );
      totalWasteValue += wsValue;
    }

    await connection.execute(
      `UPDATE inventories SET total_ws_value = ?, total_losses_value = ? WHERE id_inventories = ?`,
      [totalWsValue, totalWasteValue, inventoryId]
    );

    await connection.commit();
    res.status(201).json({ success: true, message: 'Inventory created successfully', data: { id: inventoryId, totalWsValue, totalWasteValue } });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'Error creating inventory', error: error.message });
  } finally {
    connection.release();
  }
};

const updateInventory = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const { locationId, inventoryDate, items, prepItems = [], waste = [], status } = req.body;

    const [inventory] = await connection.execute(
      'SELECT status, id_location FROM inventories WHERE id_inventories = ?', [id]
    );

    if (inventory.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }

    if (inventory[0].status === 'Locked') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Cannot edit a locked inventory' });
    }

    if (locationId && locationId !== inventory[0].id_location) {
      const activeInventoryId = await checkActiveInventory(locationId, id);
      if (activeInventoryId) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'There is already an active inventory for this location' });
      }
    }

    if (status === 'Locked') {
      if (items && items.length > 0) {
        const validation = validateInventoryItems(items);
        if (!validation.valid) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: validation.message });
        }
      }
      if (prepItems && prepItems.length > 0) {
        const validation = validateInventoryItems(prepItems);
        if (!validation.valid) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: validation.message });
        }
      }
    }

    if (inventoryDate || locationId || status) {
      const updates = [];
      const params  = [];
      if (inventoryDate) { updates.push('inventory_date = ?'); params.push(inventoryDate); }
      if (locationId)    { updates.push('id_location = ?');    params.push(locationId); }
      if (status)        { updates.push('status = ?');         params.push(status); }
      params.push(id);
      await connection.execute(`UPDATE inventories SET ${updates.join(', ')} WHERE id_inventories = ?`, params);
    }

    if ((items && items.length > 0) || prepItems.length > 0) {
      await connection.execute('DELETE FROM inventory_items WHERE id_inventory = ?', [id]);

      let totalWsValue = 0;

      for (const item of (items || [])) {
        const wsValue = parseFloat(item.wholesaleValue) || 0;
        const weights = await calculateNetWeight(connection, item.productId, item.fullWeight, item.emptyWeight);
        const pw      = calcProductWeight(parseFloat(item.quantity), item.quantityType, weights.fullWeight, weights.emptyWeight, weights.netWeight);

        await connection.execute(
          `INSERT INTO inventory_items (
            id_inventory, id_product, id_prep, item_type, id_location, display_order,
            quantity_type, quantity, case_size,
            full_weight, empty_weight, net_weight,
            product_weight, product_weight_grams, product_weight_unit,
            wholesale_value
          ) VALUES (?, ?, NULL, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, item.productId, item.locationId || null, item.displayOrder || item.order || 0,
            item.quantityType, parseFloat(item.quantity), item.caseSize ? parseInt(item.caseSize) : null,
            weights.fullWeight, weights.emptyWeight, weights.netWeight,
            pw.product_weight, pw.product_weight_grams, pw.product_weight_unit,
            wsValue
          ]
        );
        totalWsValue += wsValue;
      }

      for (const item of prepItems) {
        const quantity = parseFloat(item.quantity);
        const wsValue  = parseFloat(item.wholesaleValue) || 0;

        await connection.execute(
          `INSERT INTO inventory_items (
            id_inventory, id_product, id_prep, item_type, id_location, display_order,
            quantity_type, quantity, case_size,
            full_weight, empty_weight, net_weight,
            product_weight, product_weight_grams, product_weight_unit,
            wholesale_value
          ) VALUES (?, NULL, ?, 'prep', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
          [
            id, item.prepId, item.locationId || null, item.displayOrder || item.order || 0,
            item.quantityType, quantity,
            quantity, quantity, item.quantityType,
            wsValue
          ]
        );
        totalWsValue += wsValue;
      }

      await connection.execute('DELETE FROM inventory_losses WHERE id_inventory = ?', [id]);
      let totalWasteValue = 0;
      for (const w of waste) {
        const wsValue = parseFloat(w.wholesaleValue) || 0;
        await connection.execute(
          `INSERT INTO inventory_losses (id_inventory, id_product, quantity, unit, reason, loss_value)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, w.productId, parseFloat(w.quantity), w.quantityType || 'units', '', wsValue]
        );
        totalWasteValue += wsValue;
      }

      await connection.execute(
        `UPDATE inventories SET total_ws_value = ?, total_losses_value = ? WHERE id_inventories = ?`,
        [totalWsValue, totalWasteValue, id]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Inventory updated successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'Error updating inventory', error: error.message });
  } finally {
    connection.release();
  }
};

const deleteInventory = async (req, res) => {
  try {
    const { id } = req.params;
    const [inventory] = await pool.execute('SELECT status FROM inventories WHERE id_inventories = ?', [id]);
    if (inventory.length === 0) return res.status(404).json({ success: false, message: 'Inventory not found' });
    if (inventory[0].status === 'Locked') return res.status(400).json({ success: false, message: 'Cannot delete a locked inventory' });
    await pool.execute('DELETE FROM inventories WHERE id_inventories = ?', [id]);
    res.json({ success: true, message: 'Inventario eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting inventory', error: error.message });
  }
};

const toggleLockInventory = async (req, res) => {
  try {
    const { id } = req.params;
    const [inventory] = await pool.execute('SELECT status FROM inventories WHERE id_inventories = ?', [id]);
    if (inventory.length === 0) return res.status(404).json({ success: false, message: 'Inventory not found' });
    const newStatus = inventory[0].status === 'Locked' ? 'Unlocked' : 'Locked';
    await pool.execute('UPDATE inventories SET status = ? WHERE id_inventories = ?', [newStatus, id]);
    res.json({ success: true, message: `Inventory ${newStatus === 'Locked' ? 'locked' : 'unlocked'} successfully`, data: { status: newStatus } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating inventory status', error: error.message });
  }
};

const reorderInventoryItems = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { id } = req.params;
    const { itemOrders } = req.body;
    const [inventory] = await connection.execute('SELECT status FROM inventories WHERE id_inventories = ?', [id]);
    if (inventory.length === 0 || inventory[0].status === 'Locked') {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Cannot reorder a locked inventory' });
    }
    for (const item of itemOrders) {
      await connection.execute(
        'UPDATE inventory_items SET display_order = ? WHERE id_inventory_item = ? AND id_inventory = ?',
        [item.display_order, item.id_inventory_item, id]
      );
    }
    await connection.commit();
    res.json({ success: true, message: 'Order updated successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'Error reordering inventory items', error: error.message });
  } finally {
    connection.release();
  }
};

const getLastInventoryProducts = async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!locationId) return res.status(400).json({ success: false, message: 'locationId is required' });

    const [lastInventory] = await pool.execute(
      `SELECT id_inventories FROM inventories WHERE id_location = ? ORDER BY id_inventories DESC LIMIT 1`,
      [locationId]
    );

    if (lastInventory.length === 0) {
      return res.json({ success: true, data: [], prepData: [], message: 'No previous inventories found for this location' });
    }

    const lastInventoryId = lastInventory[0].id_inventories;

    const [items] = await pool.execute(
      `SELECT 
        ii.display_order, ii.quantity_type, ii.full_weight, ii.empty_weight, ii.net_weight,
        p.id_products as productId, p.product_name as productName, p.product_code as productCode,
        p.container_type as containerType, p.container_size as containerSize,
        p.container_unit as containerUnit, p.case_size as caseSize,
        p.full_weight_base_unit  as product_full_weight,
        p.empty_weight_base_unit as product_empty_weight,
        p.wholesale_price as wholesalePrice,
        c.category_name,
        pt.product_name AS product_type_name
       FROM inventory_items ii
       INNER JOIN products p ON ii.id_product = p.id_products
       LEFT JOIN categories c ON p.id_category = c.id_categories
       LEFT JOIN product_types pt ON p.id_product_type = pt.id_product_types
       WHERE ii.id_inventory = ? AND ii.item_type = 'product'
       ORDER BY ii.display_order ASC`,
      [lastInventoryId]
    );

    const [prepData] = await pool.execute(
      `SELECT 
        ii.display_order, ii.quantity_type,
        pr.id_preps as prepId, pr.prep_name as prepName,
        pr.yield_quantity as yieldQuantity, pr.yield_unit as yieldUnit,
        pr.yield_unit_cost as yieldUnitCost, pr.total_cost as totalCost
       FROM inventory_items ii
       INNER JOIN preps pr ON ii.id_prep = pr.id_preps
       WHERE ii.id_inventory = ? AND ii.item_type = 'prep'
       ORDER BY ii.display_order ASC`,
      [lastInventoryId]
    );

    res.json({ success: true, data: items, prepData, lastInventoryId });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching last inventory products', error: error.message });
  }
};

// ========================================
// NUEVO: Lista de inventarios por location
// GET /inventories/by-location/:locationId
// ========================================
const getInventoriesByLocation = async (req, res) => {
  try {
    const { locationId } = req.params;
    if (!locationId) {
      return res.status(400).json({ success: false, message: 'locationId is required' });
    }

    const [inventories] = await pool.execute(
      `SELECT
         i.id_inventories,
         i.inventory_date,
         i.status,
         COUNT(DISTINCT ii.id_inventory_item) as total_products
       FROM inventories i
       LEFT JOIN inventory_items ii ON i.id_inventories = ii.id_inventory
       WHERE i.id_location = ?
       GROUP BY i.id_inventories, i.inventory_date, i.status
       ORDER BY i.inventory_date DESC, i.id_inventories DESC
       LIMIT 20`,
      [locationId]
    );

    res.json({ success: true, data: inventories });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching inventories by location',
      error: error.message
    });
  }
};

// ========================================
// NUEVO: Productos de un inventario específico
// GET /inventories/:inventoryId/products?uncountedOnly=true
// ========================================
const getInventoryProducts = async (req, res) => {
  try {
    const { inventoryId } = req.params;
    const uncountedOnly   = req.query.uncountedOnly === 'true';

    if (!inventoryId) {
      return res.status(400).json({ success: false, message: 'inventoryId is required' });
    }

    // Primero obtenemos el storeId del inventario para poder buscar en products_by_store
    const [invRow] = await pool.execute(
      'SELECT id_store FROM inventories WHERE id_inventories = ?',
      [inventoryId]
    );
    if (invRow.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }
    const storeId = invRow[0].id_store;

    let items, prepData;

    if (uncountedOnly) {
      // ── MODO UNCOUNTED ─────────────────────────────────────────────────────
      // Un producto "no contado" es aquel que:
      //   1. Existe en products_by_store para esta tienda, Y
      //   2. NO aparece en inventory_items de este inventario
      //      O aparece pero con quantity IS NULL (nunca se guardó una cantidad)
      // Un producto guardado con quantity = 0 SÍ cuenta como contado y por lo
      // tanto queda excluido de este listado.
      [items] = await pool.execute(
        `SELECT
           COALESCE(ii.display_order, 9999)  AS display_order,
           COALESCE(ii.quantity_type, p.container_type) AS quantity_type,
           ii.quantity,
           COALESCE(ii.full_weight,  p.full_weight_base_unit)  AS full_weight,
           COALESCE(ii.empty_weight, p.empty_weight_base_unit) AS empty_weight,
           ii.net_weight,
           p.id_products       AS productId,
           p.product_name      AS productName,
           p.product_code      AS productCode,
           p.container_type    AS containerType,
           p.container_size    AS containerSize,
           p.container_unit    AS containerUnit,
           p.case_size         AS caseSize,
           p.full_weight_base_unit  AS product_full_weight,
           p.empty_weight_base_unit AS product_empty_weight,
           p.wholesale_price   AS wholesalePrice,
           c.category_name,
           pt.product_name     AS product_type_name
         FROM products_by_store pbs
         INNER JOIN products p   ON pbs.id_product     = p.id_products
         LEFT  JOIN inventory_items ii
               ON  ii.id_product   = p.id_products
               AND ii.id_inventory = ?
               AND ii.item_type    = 'product'
         LEFT  JOIN categories c    ON p.id_category     = c.id_categories
         LEFT  JOIN product_types pt ON p.id_product_type = pt.id_product_types
         WHERE pbs.id_store = ?
           AND (
             ii.id_inventory_item IS NULL          -- no aparece en el inventario
             OR ii.quantity IS NULL                 -- aparece pero sin cantidad
           )
         ORDER BY c.category_name ASC, p.product_name ASC`,
        [inventoryId, storeId]
      );

      // Preps no contados: los que existen en la tienda pero no están en este inventario
      // o están con quantity IS NULL (guardados con 0 SÍ cuentan como contados)
      [prepData] = await pool.execute(
        `SELECT
           COALESCE(ii.display_order, 9999) AS display_order,
           COALESCE(ii.quantity_type, pr.yield_unit) AS quantity_type,
           ii.quantity,
           pr.id_preps         AS prepId,
           pr.prep_name        AS prepName,
           pr.yield_quantity   AS yieldQuantity,
           pr.yield_unit       AS yieldUnit,
           pr.yield_unit_cost  AS yieldUnitCost,
           pr.total_cost       AS totalCost
         FROM preps pr
         LEFT JOIN inventory_items ii
               ON  ii.id_prep      = pr.id_preps
               AND ii.id_inventory = ?
               AND ii.item_type    = 'prep'
         WHERE pr.id_store = ?
           AND pr.show_in_physical_inventory = 1
           AND (
             ii.id_inventory_item IS NULL
             OR ii.quantity IS NULL
           )
         ORDER BY pr.prep_name ASC`,
        [inventoryId, storeId]
      );

    } else {
      // ── MODO NORMAL: todos los productos que sí están en inventory_items ──
      [items] = await pool.execute(
        `SELECT
           ii.display_order,
           ii.quantity_type,
           ii.quantity,
           ii.full_weight,
           ii.empty_weight,
           ii.net_weight,
           p.id_products       AS productId,
           p.product_name      AS productName,
           p.product_code      AS productCode,
           p.container_type    AS containerType,
           p.container_size    AS containerSize,
           p.container_unit    AS containerUnit,
           p.case_size         AS caseSize,
           p.full_weight_base_unit  AS product_full_weight,
           p.empty_weight_base_unit AS product_empty_weight,
           p.wholesale_price   AS wholesalePrice,
           c.category_name,
           pt.product_name     AS product_type_name
         FROM inventory_items ii
         INNER JOIN products p   ON ii.id_product     = p.id_products
         LEFT  JOIN categories c    ON p.id_category     = c.id_categories
         LEFT  JOIN product_types pt ON p.id_product_type = pt.id_product_types
         WHERE ii.id_inventory = ?
           AND ii.item_type = 'product'
         ORDER BY ii.display_order ASC`,
        [inventoryId]
      );

      [prepData] = await pool.execute(
        `SELECT
           ii.display_order,
           ii.quantity_type,
           ii.quantity,
           pr.id_preps         AS prepId,
           pr.prep_name        AS prepName,
           pr.yield_quantity   AS yieldQuantity,
           pr.yield_unit       AS yieldUnit,
           pr.yield_unit_cost  AS yieldUnitCost,
           pr.total_cost       AS totalCost
         FROM inventory_items ii
         INNER JOIN preps pr ON ii.id_prep = pr.id_preps
         WHERE ii.id_inventory = ?
           AND ii.item_type = 'prep'
         ORDER BY ii.display_order ASC`,
        [inventoryId]
      );
    }

    res.json({ success: true, data: items, prepData, inventoryId });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching inventory products',
      error: error.message
    });
  }
};

// ========================================
// NUEVO: Productos NO CONTADOS por FECHA (toda la tienda)
// GET /inventories/uncounted-by-date?storeId=&date=YYYY-MM-DD
// ----------------------------------------
// Un producto/prep está "no contado" en esa fecha si NO tiene NINGÚN registro
// con quantity IS NOT NULL en ningún inventario Locked de esa fecha, sin
// importar la locación. Un producto guardado con quantity = 0 SÍ cuenta como
// contado. Sirve para cargar en un inventario nuevo (p. ej. la location
// "No location items") lo que se quedó fuera ese día en toda la tienda.
// ========================================
const getUncountedByDate = async (req, res) => {
  try {
    const { storeId, date } = req.query;
    if (!storeId || !date) {
      return res.status(400).json({ success: false, message: 'storeId and date are required' });
    }

    // Productos de la tienda que NO fueron contados en ningún inventario Locked de esa fecha
    const [items] = await pool.execute(
      `SELECT
         9999                       AS display_order,
         p.container_type           AS quantity_type,
         NULL                       AS quantity,
         p.full_weight_base_unit    AS full_weight,
         p.empty_weight_base_unit   AS empty_weight,
         NULL                       AS net_weight,
         p.id_products              AS productId,
         p.product_name             AS productName,
         p.product_code             AS productCode,
         p.container_type           AS containerType,
         p.container_size           AS containerSize,
         p.container_unit           AS containerUnit,
         p.case_size                AS caseSize,
         p.full_weight_base_unit    AS product_full_weight,
         p.empty_weight_base_unit   AS product_empty_weight,
         p.wholesale_price          AS wholesalePrice,
         c.category_name,
         pt.product_name            AS product_type_name
       FROM products_by_store pbs
       INNER JOIN products p    ON pbs.id_product     = p.id_products
       LEFT  JOIN categories c    ON p.id_category     = c.id_categories
       LEFT  JOIN product_types pt ON p.id_product_type = pt.id_product_types
       WHERE pbs.id_store = ?
         AND NOT EXISTS (
           SELECT 1
           FROM inventory_items ii
           INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
           WHERE ii.id_product = p.id_products
             AND ii.item_type = 'product'
             AND i.id_store = ?
             AND i.status = 'Locked'
             AND DATE(i.inventory_date) = ?
             AND ii.quantity IS NOT NULL
         )
       ORDER BY c.category_name ASC, p.product_name ASC`,
      [storeId, storeId, date]
    );

    // Preps de la tienda (marcados para inventario) no contados en ningún Locked de esa fecha
    const [prepData] = await pool.execute(
      `SELECT
         9999               AS display_order,
         pr.yield_unit      AS quantity_type,
         NULL               AS quantity,
         pr.id_preps        AS prepId,
         pr.prep_name       AS prepName,
         pr.yield_quantity  AS yieldQuantity,
         pr.yield_unit      AS yieldUnit,
         pr.yield_unit_cost AS yieldUnitCost,
         pr.total_cost      AS totalCost
       FROM preps pr
       WHERE pr.id_store = ?
         AND pr.show_in_physical_inventory = 1
         AND NOT EXISTS (
           SELECT 1
           FROM inventory_items ii
           INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
           WHERE ii.id_prep = pr.id_preps
             AND ii.item_type = 'prep'
             AND i.id_store = ?
             AND i.status = 'Locked'
             AND DATE(i.inventory_date) = ?
             AND ii.quantity IS NOT NULL
         )
       ORDER BY pr.prep_name ASC`,
      [storeId, storeId, date]
    );

    res.json({ success: true, data: items, prepData, date });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching uncounted products by date',
      error: error.message
    });
  }
};

// ========================================
// IMPORTAR INVENTARIO DESDE EXCEL
// ========================================
const importInventoryFromExcel = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const { storeId, inventoryDate } = req.body;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const locationId = await getOrCreateFromExcelLocation(storeId);
    const workbook   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const worksheet  = workbook.Sheets[workbook.SheetNames[0]];

    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });

    if (rawRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'The file is empty' });
    }

    const KNOWN_HEADERS = [
      'product name', 'name', 'product code', 'code', 'sku',
      'closing inv', 'quantity', 'qty', 'inv', 'count',
      'container type', 'type', 'item type'
    ];

    const firstRow   = rawRows[0].map(c => (c ? String(c).toLowerCase().trim() : ''));
    const hasHeaders = firstRow.some(cell => KNOWN_HEADERS.includes(cell));

    const data = hasHeaders
      ? XLSX.utils.sheet_to_json(worksheet, { defval: null })
      : rawRows.map(row => ({
          'Product Name':   row[0] != null ? String(row[0]).trim() : null,
          'Closing Inv':    row[1],
          'Container Type': row[2] != null ? String(row[2]).trim() : null,
          'Type':           row[3] != null ? String(row[3]).trim() : null,
        }));

    const date = inventoryDate || new Date().toISOString().slice(0, 19).replace('T', ' ');

    let imported = 0, skipped = 0;
    const errors = [], items = [], prepItemsToInsert = [];

    for (let i = 0; i < data.length; i++) {
      const row    = data[i];
      const rowNum = i + 2;

      const rawType = getRowValue(row, 'type', 'item type', 'item_type');
      const isPrep  = rawType && ['prep', 'pre-batch', 'prebatch', 'pre batch'].includes(rawType.toLowerCase());

      const rawQuantity = getRowValue(row,
        'closing inv', 'closing inventory', 'quantity', 'qty',
        'inv', 'count', 'inventory', 'cantidad'
      );
      const quantity = parseFloat(rawQuantity) || 0;

      try {
        if (isPrep) {
          const prepName = getRowValue(row,
            'prep name', 'name', 'product name', 'item name', 'item', 'nombre'
          );
          if (!prepName)                         { skipped++; continue; }
          if (isNaN(quantity) || quantity === 0) { skipped++; continue; }

          const [prepRows] = await connection.execute(
            `SELECT id_preps, prep_name, yield_quantity, yield_unit, yield_unit_cost, total_cost
             FROM preps
             WHERE LOWER(TRIM(prep_name)) = LOWER(TRIM(?)) AND id_store = ?`,
            [prepName, storeId]
          );

          if (prepRows.length === 0) {
            errors.push(`Row ${rowNum}: Prep "${prepName}" not found in this store`);
            skipped++;
            continue;
          }

          const prep    = prepRows[0];
          const wsValue = calcPrepWholesaleValue(
            quantity, prep.yield_unit,
            prep.yield_quantity, prep.yield_unit, prep.total_cost
          );

          prepItemsToInsert.push({
            prepId:         prep.id_preps,
            prepName:       prep.prep_name,
            quantityType:   prep.yield_unit,
            quantity,
            wholesaleValue: wsValue,
            displayOrder:   imported + 1
          });
          imported++;

        } else {
          const productCode        = getRowValue(row, 'product code', 'code', 'sku', 'item code', 'codigo');
          const productName        = getRowValue(row, 'product name', 'name', 'item name', 'item', 'product', 'nombre');
          const containerTypeExcel = getRowValue(row, 'container type', 'container', 'unit type', 'weight type', 'tipo');

          if (!productCode && !productName) { skipped++; continue; }
          if (isNaN(quantity))              { skipped++; continue; }

          let productRow = null;

          if (productCode) {
            const [byCode] = await connection.execute(
              `SELECT p.id_products, p.product_name, p.product_code, p.container_type,
                 p.full_weight_base_unit  as full_weight,
                 p.empty_weight_base_unit as empty_weight,
                 p.wholesale_price, p.case_size, p.container_size, p.container_unit
               FROM products p
               INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
               WHERE LOWER(TRIM(p.product_code)) = LOWER(TRIM(?)) AND pbs.id_store = ?`,
              [productCode, storeId]
            );
            if (byCode.length > 0) productRow = byCode[0];
          }

          if (!productRow && productName) {
            const [byName] = await connection.execute(
              `SELECT p.id_products, p.product_name, p.product_code, p.container_type,
                 p.full_weight_base_unit  as full_weight,
                 p.empty_weight_base_unit as empty_weight,
                 p.wholesale_price, p.case_size, p.container_size, p.container_unit
               FROM products p
               INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
               WHERE LOWER(TRIM(p.product_name)) = LOWER(TRIM(?)) AND pbs.id_store = ?`,
              [productName, storeId]
            );
            if (byName.length > 0) productRow = byName[0];
          }

          if (!productRow) {
            errors.push(`Row ${rowNum}: Product "${productName || productCode}" not found in this store`);
            skipped++;
            continue;
          }

          const weightType     = containerTypeExcel || productRow.container_type || 'Bottle';
          const containerTypes = ['Bottle', 'Keg', 'Can', 'Each', 'Box', 'Bag', 'Carton'];
          let wholesaleValue   = 0;

          if (productRow.wholesale_price) {
            const price     = parseFloat(productRow.wholesale_price);
            const caseSize  = parseFloat(productRow.case_size) || 1;
            const unitPrice = caseSize > 0 ? price / caseSize : price;

            if (containerTypes.includes(weightType)) {
              wholesaleValue = quantity * unitPrice;
            } else if (productRow.full_weight && productRow.empty_weight !== null) {
              const full  = parseFloat(productRow.full_weight);
              const empty = parseFloat(productRow.empty_weight);
              if (full > empty) {
                const quantityInGrams = quantity * (GRAMS[weightType] || 1);
                const pct = Math.min(Math.max((quantityInGrams - empty) / (full - empty), 0), 1);
                wholesaleValue = pct * unitPrice;
              }
            }
          }

          items.push({
            productId:      productRow.id_products,
            productName:    productRow.product_name,
            quantityType:   weightType,
            quantity,
            wholesaleValue,
            fullWeight:     productRow.full_weight  || null,
            emptyWeight:    productRow.empty_weight ?? null,
            caseSize:       productRow.case_size    || null,
            displayOrder:   imported + 1
          });
          imported++;
        }
      } catch (rowError) {
        errors.push(`Row ${rowNum}: ${rowError.message}`);
        skipped++;
      }
    }

    if (items.length === 0 && prepItemsToInsert.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'No valid products or preps found in the file',
        stats: { total: data.length, imported: 0, skipped, errors }
      });
    }

    const [invResult] = await connection.execute(
      `INSERT INTO inventories (id_store, id_location, inventory_type, inventory_date, status, total_ws_value, total_losses_value)
       VALUES (?, ?, 'Standard', ?, 'Unlocked', 0, 0)`,
      [storeId, locationId, date]
    );
    const inventoryId = invResult.insertId;

    let totalWsValue = 0;

    for (const item of items) {
      const weights = await calculateNetWeight(connection, item.productId, item.fullWeight, item.emptyWeight);
      const pw      = calcProductWeight(item.quantity, item.quantityType, weights.fullWeight, weights.emptyWeight, weights.netWeight);

      await connection.execute(
        `INSERT INTO inventory_items (
          id_inventory, id_product, id_prep, item_type, id_location, display_order,
          quantity_type, quantity, case_size, full_weight, empty_weight, net_weight,
          product_weight, product_weight_grams, product_weight_unit, wholesale_value
        ) VALUES (?, ?, NULL, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inventoryId, item.productId, locationId, item.displayOrder,
          item.quantityType, item.quantity, item.caseSize ? parseInt(item.caseSize) : null,
          weights.fullWeight, weights.emptyWeight, weights.netWeight,
          pw.product_weight, pw.product_weight_grams, pw.product_weight_unit, item.wholesaleValue
        ]
      );
      totalWsValue += item.wholesaleValue;
    }

    const baseOrder = items.length + 1;
    for (let idx = 0; idx < prepItemsToInsert.length; idx++) {
      const item = prepItemsToInsert[idx];
      await connection.execute(
        `INSERT INTO inventory_items (
          id_inventory, id_product, id_prep, item_type, id_location, display_order,
          quantity_type, quantity, case_size,
          full_weight, empty_weight, net_weight,
          product_weight, product_weight_grams, product_weight_unit,
          wholesale_value
        ) VALUES (?, NULL, ?, 'prep', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        [
          inventoryId, item.prepId, locationId, baseOrder + idx,
          item.quantityType, item.quantity,
          item.quantity, item.quantity, item.quantityType,
          item.wholesaleValue
        ]
      );
      totalWsValue += item.wholesaleValue;
    }

    await connection.execute(
      `UPDATE inventories SET total_ws_value = ? WHERE id_inventories = ?`,
      [totalWsValue, inventoryId]
    );
    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Import completed',
      data: { inventoryId, locationId, locationName: 'From Excel' },
      stats: {
        total:            data.length,
        imported,
        importedProducts: items.length,
        importedPreps:    prepItemsToInsert.length,
        skipped,
        errors: errors.length > 0 ? errors : undefined
      }
    });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'Error importing inventory', error: error.message });
  } finally {
    connection.release();
  }
};

// ========================================
// GET PRODUCTS FOR PRINT
// ========================================
const getProductsForPrintInventory = async (req, res) => {
  try {
    const { storeId, locationId } = req.query;
    if (!storeId || !locationId) {
      return res.status(400).json({ success: false, message: 'storeId and locationId are required' });
    }

    const [lastInventory] = await pool.execute(
      `SELECT id_inventories FROM inventories
       WHERE id_location = ? AND status = 'Locked'
       ORDER BY inventory_date DESC LIMIT 1`,
      [locationId]
    );

    if (lastInventory.length === 0) {
      return res.json({ success: true, data: [], message: 'No locked inventory found for this location' });
    }

    const [productItems] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name as name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.container_type,
        c.category_name,
        pt.product_name AS product_type_name,
        'product' as item_type,
        ROUND(SUM(
          CASE
            WHEN ii.quantity_type IN ('Bottle', 'Can', 'Keg', 'Each', 'Box', 'Bag', 'Carton') THEN ii.quantity
            WHEN ii.quantity_type IN ('g', 'kg', 'oz', 'lb', 'ml', 'L', 'Liter', 'Gallon', 'fl oz') THEN
              CASE
                WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight IS NOT NULL AND ii.empty_weight > 0 THEN
                  (CASE ii.quantity_type
                    WHEN 'kg' THEN ii.quantity * 1000 WHEN 'oz' THEN ii.quantity * 28.3495
                    WHEN 'lb' THEN ii.quantity * 453.592 WHEN 'L' THEN ii.quantity * 1000
                    WHEN 'Liter' THEN ii.quantity * 1000 WHEN 'Gallon' THEN ii.quantity * 3785.41
                    WHEN 'fl oz' THEN ii.quantity * 29.5735 ELSE ii.quantity END
                    - ii.empty_weight) / ii.net_weight
                ELSE ii.product_weight_grams / NULLIF(p.container_size_base_unit, 0)
              END
            ELSE ii.quantity
          END
        ), 2) as last_inv_quantity
       FROM inventory_items ii
       INNER JOIN products p ON ii.id_product = p.id_products
       INNER JOIN categories c ON p.id_category = c.id_categories
       LEFT JOIN product_types pt ON p.id_product_type = pt.id_product_types
       WHERE ii.id_inventory = ? AND ii.item_type = 'product'
       GROUP BY p.id_products
       ORDER BY c.category_name ASC, p.product_name ASC`,
      [lastInventory[0].id_inventories]
    );

    const [prepItems] = await pool.execute(
      `SELECT
        pr.id_preps,
        pr.prep_name as name,
        pr.yield_unit as container_unit,
        'prep' as item_type,
        'Pre-Batch' as category_name,
        'Pre-Batch' as product_type_name,
        pr.yield_unit as quantity_type,
        SUM(ii.quantity) as last_inv_quantity
       FROM inventory_items ii
       INNER JOIN preps pr ON ii.id_prep = pr.id_preps
       WHERE ii.id_inventory = ? AND ii.item_type = 'prep'
       GROUP BY pr.id_preps, pr.prep_name, pr.yield_unit
       ORDER BY pr.prep_name ASC`,
      [lastInventory[0].id_inventories]
    );

    res.json({ success: true, data: [...productItems, ...prepItems] });
  } catch (error) {
    console.error('❌ print error:', error.message);
    res.status(500).json({ success: false, message: 'Error fetching products for print', error: error.message });
  }
};

// ========================================
// BUSCAR PRODUCTO EN INVENTARIOS DE UNA FECHA
// GET /inventories/search-product?storeId=&date=YYYY-MM-DD&q=texto
// Por cada producto que coincida (nombre o código) devuelve, por location:
//   - weight_type / quantity : lo contado en los inventarios de esa fecha
//   - last_quantity / last_weight_type : lo contado en el último inventario
//     Locked anterior a esa fecha (misma definición de "Last Inv" del resto del módulo:
//     el día Locked más reciente de la tienda, filtrado por location)
// Las cantidades van tal cual se capturaron (g, Bottle, Each...), sin convertir.
// ========================================
const searchProductInInventories = async (req, res) => {
  try {
    const { storeId, date, q } = req.query;
    const term = (q || '').trim();
    if (!storeId || !date) {
      return res.status(400).json({ success: false, message: 'storeId and date are required' });
    }
    if (term.length < 2) {
      return res.json({ success: true, data: [], prev_date: null });
    }

    // Escapa comodines de LIKE para que "50%" o "a_b" se busquen literal
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;

    const [products] = await pool.execute(
      `SELECT p.id_products AS id_product, p.product_name, p.product_code, p.container_type
       FROM products p
       INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
       WHERE pbs.id_store = ?
         AND (p.product_name LIKE ? OR p.product_code LIKE ?)
       ORDER BY p.product_name ASC
       LIMIT 25`,
      [storeId, like, like]
    );
    if (products.length === 0) {
      return res.json({ success: true, data: [], prev_date: null });
    }
    const ids = products.map(p => p.id_product);
    const idPlaceholders = ids.map(() => '?').join(',');

    // Inventario Locked inmediatamente anterior a la fecha elegida (toda la tienda)
    const [prevRows] = await pool.execute(
      `SELECT DATE_FORMAT(MAX(DATE(i.inventory_date)), '%Y-%m-%d') AS prev_date
       FROM inventories i
       WHERE i.id_store = ?
         AND i.status = 'Locked'
         AND DATE(i.inventory_date) < ?`,
      [storeId, date]
    );
    const prevDate = prevRows[0]?.prev_date || null;

    // Cantidades por producto / location / tipo de peso en un día dado
    const loadDay = async (day, onlyLocked) => {
      const [rows] = await pool.execute(
        `SELECT
           ii.id_product,
           COALESCE(ii.id_location, i.id_location)  AS id_location,
           COALESCE(l.location_name, 'No location') AS location_name,
           ii.quantity_type,
           SUM(ii.quantity)                          AS quantity
         FROM inventory_items ii
         INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
         LEFT  JOIN locations   l ON l.id_locations = COALESCE(ii.id_location, i.id_location)
         WHERE i.id_store = ?
           AND DATE(i.inventory_date) = ?
           ${onlyLocked ? "AND i.status = 'Locked'" : ''}
           AND ii.item_type = 'product'
           AND ii.quantity IS NOT NULL
           AND ii.id_product IN (${idPlaceholders})
         GROUP BY ii.id_product, COALESCE(ii.id_location, i.id_location), l.location_name, ii.quantity_type
         ORDER BY location_name ASC`,
        [storeId, day, ...ids]
      );
      return rows;
    };

    const currentRows = await loadDay(date, false);
    const lastRows    = prevDate ? await loadDay(prevDate, true) : [];

    const round = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

    // Physical Inventory guarda TODO con quantity_type 'Each' (cuenta contenedores).
    // Para que no salga como un tipo aparte, 'Each' se muestra como el contenedor
    // del producto (Bottle, Can, Bag...). Después se suman las filas que quedaron
    // iguales (mismo producto, location y tipo).
    const containerOf = {};
    products.forEach(p => { containerOf[p.id_product] = p.container_type; });
    const normalizeRows = (rows) => {
      const merged = {};
      rows.forEach(r => {
        const ct = containerOf[r.id_product];
        const type = (r.quantity_type === 'Each' && ct && ct !== 'Each') ? ct : r.quantity_type;
        const key = `${r.id_product}|${r.id_location ?? 'none'}|${type}`;
        if (!merged[key]) merged[key] = { ...r, quantity_type: type, quantity: 0 };
        merged[key].quantity += parseFloat(r.quantity) || 0;
      });
      return Object.values(merged);
    };

    // product -> location -> fila combinada (actual + último)
    const byProduct = {};
    const rowFor = (idProduct, idLocation, locationName) => {
      const pk = String(idProduct);
      const lk = String(idLocation ?? 'none');
      byProduct[pk] = byProduct[pk] || {};
      byProduct[pk][lk] = byProduct[pk][lk] || {
        id_location: idLocation,
        location_name: locationName,
        weight_type: null,
        quantity: null,
        last_weight_type: null,
        last_quantity: null,
      };
      return byProduct[pk][lk];
    };

    normalizeRows(currentRows).forEach(r => {
      const row = rowFor(r.id_product, r.id_location, r.location_name);
      // Si en una misma location hubo dos tipos de peso, se queda el de mayor cantidad
      if (row.quantity === null || round(r.quantity) > row.quantity) {
        row.weight_type = r.quantity_type;
        row.quantity    = round(r.quantity);
      }
    });
    normalizeRows(lastRows).forEach(r => {
      const row = rowFor(r.id_product, r.id_location, r.location_name);
      if (row.last_quantity === null || round(r.quantity) > row.last_quantity) {
        row.last_weight_type = r.quantity_type;
        row.last_quantity    = round(r.quantity);
      }
    });

    // Solo productos que aparecen en alguno de los dos días
    const data = products
      .filter(p => byProduct[String(p.id_product)])
      .map(p => ({
        id_product:   p.id_product,
        product_name: p.product_name,
        product_code: p.product_code,
        locations: Object.values(byProduct[String(p.id_product)])
          .sort((a, b) => String(a.location_name).localeCompare(String(b.location_name))),
      }));

    res.json({ success: true, data, prev_date: prevDate, date });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error searching product', error: error.message });
  }
};

module.exports = {
  searchProductInInventories,
  getAllInventories,
  getInventoryById,
  createInventory,
  updateInventory,
  deleteInventory,
  toggleLockInventory,
  getAvailableProducts,
  reorderInventoryItems,
  getLastInventoryProducts,
  importInventoryFromExcel,
  getProductsForPrintInventory,
  getInventoriesByLocation,
  getInventoryProducts,
  getUncountedByDate,
};