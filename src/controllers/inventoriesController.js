const pool = require('../config/database');
const XLSX = require('xlsx');

// ========================================
// FUNCIONES AUXILIARES
// ========================================

const checkActiveInventory = async (locationId, excludeInventoryId = null) => {
  let query = `
    SELECT id_inventories 
    FROM inventories 
    WHERE id_location = ? AND (status = 'Unlocked' OR status = 'Unlocked')
  `;
  const params = [locationId];
  if (excludeInventoryId) {
    query += ' AND id_inventories != ?';
    params.push(excludeInventoryId);
  }
  const [result] = await pool.execute(query, params);
  return result.length > 0 ? result[0].id_inventories : null;
};

const getLastInventoryOrder = async (locationId) => {
  const [result] = await pool.execute(
    `SELECT ii.id_product, ii.display_order
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
  let fullWeight  = itemFullWeight  ? parseFloat(itemFullWeight)  : null;
  let emptyWeight = itemEmptyWeight !== undefined && itemEmptyWeight !== null && itemEmptyWeight !== ''
    ? parseFloat(itemEmptyWeight)
    : null;

  if (!fullWeight || emptyWeight === null) {
    const [product] = await connection.execute(
      `SELECT full_weight, empty_weight FROM products WHERE id_products = ?`,
      [productId]
    );
    if (product.length > 0) {
      fullWeight  = fullWeight  ?? (parseFloat(product[0].full_weight)  || null);
      emptyWeight = emptyWeight ?? (product[0].empty_weight !== null ? parseFloat(product[0].empty_weight) : null);
    }
  }

  if (fullWeight && emptyWeight !== null && fullWeight > emptyWeight) {
    return { fullWeight, emptyWeight, netWeight: fullWeight - emptyWeight };
  }

  return { fullWeight: fullWeight || null, emptyWeight: emptyWeight ?? null, netWeight: null };
};

// ========================================
// HELPER — calcular product_weight, product_weight_grams, product_weight_unit
// ========================================
const GRAMS = {
  g: 1, kg: 1000, oz: 28.3495, lb: 453.592,
  ml: 1, L: 1000, Liter: 1000, Gallon: 3785.41, 'fl oz': 29.5735
};

const COUNT_UNITS = ['Bottle', 'Keg', 'Can', 'Each', 'Box', 'Bag', 'Carton'];
const VOLUME_UNITS = ['ml', 'L', 'Liter', 'Gallon', 'fl oz'];
const WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb'];

const calcProductWeight = (quantity, quantityType, fullWeight, emptyWeight, netWeight) => {
  const qty = parseFloat(quantity) || 0;

  // Contables — no tiene producto_weight en gramos, es unit
  if (COUNT_UNITS.includes(quantityType)) {
    return {
      product_weight:       qty,
      product_weight_grams: qty,
      product_weight_unit:  'unit'
    };
  }

  const isWeightOrVolume = WEIGHT_UNITS.includes(quantityType) || VOLUME_UNITS.includes(quantityType);

  if (isWeightOrVolume) {
    const qtyInGrams  = qty * (GRAMS[quantityType] || 1);
    const baseUnit    = VOLUME_UNITS.includes(quantityType) ? 'ml' : 'g';
    const emptyVal    = (emptyWeight !== null && emptyWeight !== undefined) ? parseFloat(emptyWeight) : 0;
    const netVal      = parseFloat(netWeight) || 0;
    const fullVal     = parseFloat(fullWeight) || 0;

    if (netVal > 0 && fullVal > 0 && emptyVal > 0) {
      // Botella pesada — product_weight es el neto actual
      const productWeightGrams = qtyInGrams - emptyVal;
      return {
        product_weight:       parseFloat(productWeightGrams.toFixed(4)),
        product_weight_grams: parseFloat(productWeightGrams.toFixed(4)),
        product_weight_unit:  baseUnit
      };
    } else {
      // A granel — la cantidad ya es el producto
      return {
        product_weight:       qty,
        product_weight_grams: parseFloat(qtyInGrams.toFixed(4)),
        product_weight_unit:  baseUnit
      };
    }
  }

  // Fallback
  return {
    product_weight:       qty,
    product_weight_grams: qty,
    product_weight_unit:  'unit'
  };
};

const validateInventoryItems = (items) => {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.quantity === null || item.quantity === undefined || item.quantity === '') {
      return {
        valid: false,
        message: `Please enter a quantity for ${item.productName || 'product ' + (i + 1)}`
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
        p.full_weight as product_full_weight,
        p.empty_weight as product_empty_weight,
        p.wholesale_price,
        l.location_name
       FROM inventory_items ii
       INNER JOIN products p ON ii.id_product = p.id_products
       LEFT JOIN locations l ON ii.id_location = l.id_locations
       WHERE ii.id_inventory = ?
       ORDER BY ii.display_order ASC, p.product_name`,
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
    res.json({ success: true, data: { ...inventory[0], items, losses } });
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
        p.full_weight,
        p.empty_weight,
        p.full_weight_unit as weight_unit,
        pbs.par,
        pbs.reorder_point,
        pbs.order_by_the
       FROM products p
       INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
       WHERE pbs.id_store = ?
       ORDER BY p.product_name`,
      [storeId]
    );
    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching available products', error: error.message });
  }
};

const createInventory = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { storeId, locationId, inventoryDate, items, waste = [] } = req.body;

    if (!storeId || !inventoryDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Store and date are required' });
    }

    const status = req.body.status || 'Open';
    if (status === 'Locked' && (!items || items.length === 0)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please add at least one product before closing the inventory' });
    }

    if (!locationId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Location is required' });
    }

    if (status === 'Locked') {
      const activeInventoryId = await checkActiveInventory(locationId);
      if (activeInventoryId) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'There is already an active inventory for this location. Please close it before creating a new one.' });
      }
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

      const lastOrder = await getLastInventoryOrder(locationId);
      const orderMap  = new Map();
      lastOrder.forEach(item => orderMap.set(item.id_product, item.display_order));

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

      // Calcular product_weight, product_weight_grams, product_weight_unit
      const pw = calcProductWeight(quantity, item.quantityType, weights.fullWeight, weights.emptyWeight, weights.netWeight);

      await connection.execute(
        `INSERT INTO inventory_items (
          id_inventory, id_product, id_location, display_order,
          quantity_type, quantity, case_size,
          full_weight, empty_weight, net_weight,
          product_weight, product_weight_grams, product_weight_unit,
          wholesale_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const { locationId, inventoryDate, items, waste = [], status } = req.body;

    const [inventory] = await connection.execute(
      'SELECT status, id_location FROM inventories WHERE id_inventories = ?',
      [id]
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

    if (items && items.length > 0 && status === 'Locked') {
      const validation = validateInventoryItems(items);
      if (!validation.valid) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: validation.message });
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

    if (items && items.length > 0) {
      await connection.execute('DELETE FROM inventory_items WHERE id_inventory = ?', [id]);

      let totalWsValue = 0;
      for (const item of items) {
        const wsValue = parseFloat(item.wholesaleValue) || 0;
        const weights = await calculateNetWeight(connection, item.productId, item.fullWeight, item.emptyWeight);

        // Calcular product_weight, product_weight_grams, product_weight_unit
        const pw = calcProductWeight(parseFloat(item.quantity), item.quantityType, weights.fullWeight, weights.emptyWeight, weights.netWeight);

        await connection.execute(
          `INSERT INTO inventory_items (
            id_inventory, id_product, id_location, display_order,
            quantity_type, quantity, case_size,
            full_weight, empty_weight, net_weight,
            product_weight, product_weight_grams, product_weight_unit,
            wholesale_value
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    res.json({
      success: true,
      message: `Inventory ${newStatus === 'Locked' ? 'locked' : 'unlocked'} successfully`,
      data: { status: newStatus }
    });
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
      return res.json({ success: true, data: [], message: 'No previous inventories found for this location' });
    }

    const lastInventoryId = lastInventory[0].id_inventories;

    const [items] = await pool.execute(
      `SELECT 
        ii.display_order,
        ii.quantity_type,
        ii.full_weight,
        ii.empty_weight,
        ii.net_weight,
        p.id_products as productId,
        p.product_name as productName,
        p.product_code as productCode,
        p.container_type as containerType,
        p.container_size as containerSize,
        p.container_unit as containerUnit,
        p.case_size as caseSize,
        p.full_weight as product_full_weight,
        p.empty_weight as product_empty_weight,
        p.wholesale_price as wholesalePrice
       FROM inventory_items ii
       INNER JOIN products p ON ii.id_product = p.id_products
       WHERE ii.id_inventory = ?
       ORDER BY ii.display_order ASC`,
      [lastInventoryId]
    );

    res.json({ success: true, data: items, lastInventoryId });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching last inventory products', error: error.message });
  }
};

// ========================================
// IMPORTAR INVENTARIO DESDE EXCEL
// ========================================
const importInventoryFromExcel = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const { storeId, inventoryDate } = req.body;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    const locationId = await getOrCreateFromExcelLocation(storeId);

    const workbook  = XLSX.read(req.file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data      = XLSX.utils.sheet_to_json(worksheet, { defval: null });

    const date = inventoryDate || new Date().toISOString().slice(0, 19).replace('T', ' ');

    let imported = 0;
    let skipped  = 0;
    const errors = [];
    const items  = [];

    for (let i = 0; i < data.length; i++) {
      const row    = data[i];
      const rowNum = i + 2;

      const productCode        = row['Product Code'] ? String(row['Product Code']).trim() : null;
      const productName        = row['Product Name'] ? String(row['Product Name']).trim() : null;
      const containerTypeExcel = row['Container Type'] ? String(row['Container Type']).trim() : null;

      if (!productCode && !productName) { skipped++; continue; }

      const quantity = parseFloat(row['Closing Inv']) || 0;
      if (quantity === null || quantity === undefined || isNaN(quantity)) { skipped++; continue; }

      try {
        let productRow = null;

        if (productCode) {
          const [byCode] = await connection.execute(
            `SELECT p.id_products, p.product_name, p.product_code, p.container_type,
               p.full_weight_base_unit as full_weight, p.empty_weight_base_unit as empty_weight,
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
               p.full_weight_base_unit as full_weight, p.empty_weight_base_unit as empty_weight,
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

        const weightType = containerTypeExcel || productRow.container_type || 'Bottle';

        const containerTypes = ['Bottle', 'Keg', 'Can', 'Each', 'Box', 'Bag', 'Carton'];
        let wholesaleValue = 0;
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
          productId:    productRow.id_products,
          productName:  productRow.product_name,
          quantityType: weightType,
          quantity,
          wholesaleValue,
          fullWeight:   productRow.full_weight  || null,
          emptyWeight:  productRow.empty_weight ?? null,
          caseSize:     productRow.case_size    || null,
          displayOrder: imported + 1
        });

        imported++;
      } catch (rowError) {
        console.error(`Error processing row ${rowNum}:`, rowError);
        errors.push(`Row ${rowNum}: ${rowError.message}`);
        skipped++;
      }
    }

    if (items.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'No valid products found in the file',
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
      const pw = calcProductWeight(item.quantity, item.quantityType, weights.fullWeight, weights.emptyWeight, weights.netWeight);

      await connection.execute(
        `INSERT INTO inventory_items (
          id_inventory, id_product, id_location, display_order,
          quantity_type, quantity, case_size,
          full_weight, empty_weight, net_weight,
          product_weight, product_weight_grams, product_weight_unit,
          wholesale_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inventoryId, item.productId, locationId, item.displayOrder,
          item.quantityType, item.quantity, item.caseSize ? parseInt(item.caseSize) : null,
          weights.fullWeight, weights.emptyWeight, weights.netWeight,
          pw.product_weight, pw.product_weight_grams, pw.product_weight_unit,
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
      stats: { total: data.length, imported, skipped, errors: errors.length > 0 ? errors : undefined }
    });

  } catch (error) {
    await connection.rollback();
    console.error('Import inventory error:', error);
    res.status(500).json({ success: false, message: 'Error importing inventory', error: error.message });
  } finally {
    connection.release();
  }
};

// ========================================
// GET PRODUCTS FOR PRINT INVENTORY BY LOCATION
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

    const [items] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.container_type,
        c.category_name,
        ROUND(SUM(
          CASE
            WHEN ii.quantity_type IN ('Bottle', 'Can', 'Keg', 'Each', 'Box', 'Bag', 'Carton') THEN ii.quantity
            WHEN ii.quantity_type IN ('g', 'kg', 'oz', 'lb', 'ml', 'L', 'Liter', 'Gallon', 'fl oz') THEN
              CASE
                WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight IS NOT NULL AND ii.empty_weight > 0 THEN
                  (
                    CASE ii.quantity_type
                      WHEN 'kg'     THEN ii.quantity * 1000
                      WHEN 'oz'     THEN ii.quantity * 28.3495
                      WHEN 'lb'     THEN ii.quantity * 453.592
                      WHEN 'L'      THEN ii.quantity * 1000
                      WHEN 'Liter'  THEN ii.quantity * 1000
                      WHEN 'Gallon' THEN ii.quantity * 3785.41
                      WHEN 'fl oz'  THEN ii.quantity * 29.5735
                      ELSE ii.quantity
                    END
                    - ii.empty_weight
                  ) / ii.net_weight
                ELSE ii.product_weight_grams / NULLIF(p.container_size_base_unit, 0)
              END
            ELSE ii.quantity
          END
        ), 2) as last_inv_quantity
       FROM inventory_items ii
       INNER JOIN products p ON ii.id_product = p.id_products
       INNER JOIN categories c ON p.id_category = c.id_categories
       WHERE ii.id_inventory = ?
       GROUP BY p.id_products
       ORDER BY c.category_name ASC, p.product_name ASC`,
      [lastInventory[0].id_inventories]
    );

    res.json({ success: true, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching products for print', error: error.message });
  }
};

module.exports = {
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
  getProductsForPrintInventory
};