const pool = require('../config/database');
const { sendOrderEmail: sendEmail } = require('../services/emailService');

// ============================================
// GET INVENTORIES FOR SELECTOR
// ============================================
const getInventoriesForOrdering = async (req, res) => {
  try {
    const { storeId } = req.query;

    if (!storeId) {
      return res.status(400).json({ message: 'Store ID is required' });
    }

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
    console.error('Error fetching inventories for ordering:', error);
    res.status(500).json({ message: 'Error fetching inventories', error: error.message });
  }
};

// ============================================
// HELPERS DE CONVERSIÓN
// ============================================
const toBaseGrams = (quantity, unit) => {
  switch (unit) {
    case 'kg':     return quantity * 1000;
    case 'oz':     return quantity * 28.3495;
    case 'lb':     return quantity * 453.592;
    case 'L':
    case 'Liter':  return quantity * 1000;
    case 'Gallon': return quantity * 3785.41;
    case 'fl oz':  return quantity * 29.5735;
    case 'g':
    case 'ml':
    default:       return quantity;
  }
};

const calcStockUnits = (rows, containerSizeBaseUnit) => {
  let total = 0;

  for (const row of rows) {
    const qty   = parseFloat(row.quantity)    || 0;
    const full  = parseFloat(row.full_weight) || 0;
    const net   = parseFloat(row.net_weight)  || 0;
    const qtype = row.quantity_type;

    const countUnits = ['Bottle', 'Can', 'Keg', 'Each', 'Box', 'Bag', 'Carton'];

    if (countUnits.includes(qtype)) {
      total += qty;
    } else {
      const emptyIsReal = (row.empty_weight !== null && row.empty_weight !== undefined);
      const emptyVal    = emptyIsReal ? parseFloat(row.empty_weight) : 0;

      if (net > 0 && full > 0 && emptyIsReal && emptyVal > 0) {
        const qtyInGrams = toBaseGrams(qty, qtype);
        const pct = (qtyInGrams - emptyVal) / net;
        total += Math.max(0, pct);
      } else {
        const qtyInGrams = toBaseGrams(qty, qtype);
        const contBase   = parseFloat(containerSizeBaseUnit) || 1;
        total += contBase > 0 ? qtyInGrams / contBase : 0;
      }
    }
  }

  return total;
};

// ============================================
// GENERATE ORDER NUMBER (inline — no SP)
// ============================================
const generateOrderNumber = async (connection, storeId) => {
  const year = new Date().getFullYear();

  const [[lastOrder]] = await connection.execute(
    `SELECT order_number FROM orders 
     WHERE id_store = ? AND order_number LIKE ?
     ORDER BY id_orders DESC LIMIT 1`,
    [storeId, `ORD-${year}-%`]
  );

  let nextNum = 1;
  if (lastOrder?.order_number) {
    const parts = lastOrder.order_number.split('-');
    const parsed = parseInt(parts[2]);
    if (!isNaN(parsed)) nextNum = parsed + 1;
  }

  return `ORD-${year}-${String(nextNum).padStart(3, '0')}`;
};

// ============================================
// CALCULATE ORDER SUGGESTIONS
// ============================================
const calculateOrderSuggestions = async (req, res) => {
  try {
    const { inventoryId, storeId } = req.body;

    if (!inventoryId || !storeId) {
      return res.status(400).json({ message: 'Inventory ID and Store ID are required' });
    }

    const [productsWithVendors] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.container_size_base_unit,
        p.container_size_base_unit_type,
        p.wholesale_price,
        p.case_size,
        pbs.par,
        pbs.reorder_point,
        pbs.order_by_the as order_by,
        v.id_vendors,
        v.vendor_name,
        v.email as vendor_email,
        c.category_name
      FROM products p
      INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
      LEFT JOIN vendors v ON p.id_vendor = v.id_vendors
      LEFT JOIN categories c ON p.id_category = c.id_categories
      WHERE pbs.id_store = ?
      ORDER BY v.vendor_name, c.category_name, p.product_name`,
      [storeId]
    );

    // Items del inventario actual
    const [inventoryItems] = await pool.execute(
      `SELECT
        ii.id_product,
        ii.quantity_type,
        ii.quantity,
        ii.full_weight,
        ii.empty_weight,
        ii.net_weight
      FROM inventory_items ii
      INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
      WHERE i.id_store = ?
        AND i.status = 'Locked'
        AND DATE(i.inventory_date) = (
          SELECT DATE(inventory_date)
          FROM inventories
          WHERE id_inventories = ?
        )`,
      [storeId, inventoryId]
    );

    // ── Fecha del inventario actual ───────────────────────────────────────────
    const [[currentInvRow]] = await pool.execute(
      'SELECT DATE(inventory_date) as inv_date FROM inventories WHERE id_inventories = ?',
      [inventoryId]
    );
    const currentInvDate = currentInvRow?.inv_date || null;

    // ── Inventario anterior (más reciente antes del actual, mismo store, locked) ──
    const [[prevInvRow]] = await pool.execute(
      `SELECT DATE(inventory_date) as inv_date
       FROM inventories
       WHERE id_store = ? AND status = 'Locked'
         AND DATE(inventory_date) < ?
       ORDER BY inventory_date DESC
       LIMIT 1`,
      [storeId, currentInvDate]
    );
    const prevInvDate = prevInvRow?.inv_date || null;

    // ── Items del inventario anterior ─────────────────────────────────────────
    const prevItemsByProduct = {};
    if (prevInvDate) {
      const [prevItems] = await pool.execute(
        `SELECT ii.id_product, ii.quantity_type, ii.quantity,
                ii.full_weight, ii.empty_weight, ii.net_weight
         FROM inventory_items ii
         INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
         WHERE i.id_store = ? AND i.status = 'Locked'
           AND DATE(i.inventory_date) = ?`,
        [storeId, prevInvDate]
      );
      prevItems.forEach(item => {
        if (!prevItemsByProduct[item.id_product]) prevItemsByProduct[item.id_product] = [];
        prevItemsByProduct[item.id_product].push(item);
      });
    }

    // ── Compras (invoices) entre inventario anterior y actual ─────────────────
    // ⚠️  Verifica que los nombres de tabla coincidan con tu esquema:
    //     - Tabla de facturas:       invoices      (columnas: id_invoices, id_store, invoice_date)
    //     - Tabla de items factura:  invoice_items (columnas: id_invoice, id_product, quantity)
    // ── Compras (invoices) entre inventario anterior y actual ─────────────────
    const purchaseByProduct = {};
    if (prevInvDate && currentInvDate) {
      try {
        const [purchases] = await pool.execute(
          `SELECT 
             ii.id_product,
             SUM(ii.received_qty) as total_qty
           FROM invoice_items ii
           INNER JOIN invoices inv ON ii.id_invoice = inv.id_invoice
           LEFT JOIN orders o ON inv.id_order = o.id_orders
           WHERE inv.id_store = ?
             AND inv.status = 'Saved'
             AND ii.received_qty IS NOT NULL
             AND DATE(COALESCE(inv.invoice_date, o.sent_at, inv.created_at)) >= ?
             AND DATE(COALESCE(inv.invoice_date, o.sent_at, inv.created_at)) < ?
           GROUP BY ii.id_product`,
          [storeId, prevInvDate, currentInvDate]
        );
        purchases.forEach(p => {
          purchaseByProduct[p.id_product] = parseFloat(p.total_qty) || 0;
        });
      } catch (e) {
        console.warn('⚠️  Error fetching purchases:', e.message);
      }
    }

    // ── Agrupar items del inventario actual por producto ──────────────────────
    const itemsByProduct = {};
    inventoryItems.forEach(item => {
      if (!itemsByProduct[item.id_product]) itemsByProduct[item.id_product] = [];
      itemsByProduct[item.id_product].push(item);
    });

    const countedProductIds = new Set(Object.keys(itemsByProduct).map(Number));

    const productMap = {};
    productsWithVendors.forEach(p => { productMap[p.id_products] = p; });

    // ── Stock on hand actual ──────────────────────────────────────────────────
    const stockMap = {};
    countedProductIds.forEach(productId => {
      const rows    = itemsByProduct[productId];
      const product = productMap[productId];
      if (!product) return;
      const containerSizeBaseUnit = parseFloat(product.container_size_base_unit) || 1;
      stockMap[productId] = calcStockUnits(rows, containerSizeBaseUnit);
    });

    // ── Armar grupos por vendor ───────────────────────────────────────────────
    const vendorGroups = {};

    productsWithVendors.forEach(product => {
      const vendorId   = product.id_vendors || 'no-vendor';
      const vendorName = product.vendor_name || 'No Vendor';

      if (!vendorGroups[vendorId]) {
        vendorGroups[vendorId] = {
          vendor_id:    product.id_vendors,
          vendor_name:  vendorName,
          vendor_email: product.vendor_email,
          products:     []
        };
      }

      const containerSizeBaseUnit = parseFloat(product.container_size_base_unit) || 1;
      const stockOnHand   = stockMap[product.id_products] !== undefined ? stockMap[product.id_products] : 0;
      const reorderPoint  = parseFloat(product.reorder_point) || 0;
      const par           = parseFloat(product.par)           || 0;
      const caseSize      = parseFloat(product.case_size)     || 1;
      const orderBy       = product.order_by || product.container_type;
      const isOrderByCase = orderBy === 'Case';

      const parForCalc     = isOrderByCase ? par / caseSize         : par;
      const reorderForCalc = isOrderByCase ? reorderPoint / caseSize : reorderPoint;
      const stockForCalc   = isOrderByCase ? stockOnHand / caseSize  : stockOnHand;

      const wholesalePrice = parseFloat(product.wholesale_price) || 0;
      const unitPrice = isOrderByCase
        ? wholesalePrice
        : (caseSize > 0 ? wholesalePrice / caseSize : wholesalePrice);

      let suggestedOrder = 0;
      if (stockForCalc <= reorderForCalc) {
        const unitsNeeded = parForCalc - stockForCalc;
        suggestedOrder = Math.ceil(unitsNeeded);
        if (suggestedOrder < 0) suggestedOrder = 0;
      }

      // ── Opening Last Inv ────────────────────────────────────────────────────
      const prevRows   = prevItemsByProduct[product.id_products] || [];
      const openingRaw = prevRows.length > 0
        ? calcStockUnits(prevRows, containerSizeBaseUnit)
        : 0;
      const openingLastInv = isOrderByCase ? openingRaw / caseSize : openingRaw;

      // ── Purchase (facturas entre inventario anterior y actual) ──────────────
      // Las cantidades en invoice_items se asumen en unidades de contenedor (botellas, etc.)
      const purchaseRaw = purchaseByProduct[product.id_products] || 0;
      const purchase = purchaseRaw;

      // ── Sold (0 por ahora) ──────────────────────────────────────────────────
      const sold = 0;

      // ── Variance = Stock on hand - (Opening + Purchase) + Sold ─────────────
      const variance = stockForCalc - (openingLastInv + purchase) + sold;

      vendorGroups[vendorId].products.push({
        id_product:                product.id_products,
        product_name:              product.product_name,
        product_code:              product.product_code,
        container_size:            product.container_size,
        container_unit:            product.container_unit,
        category_name:             product.category_name || 'Uncategorized',
        // Stock actual
        stock_on_hand:             parseFloat(stockForCalc.toFixed(4)),
        stock_on_hand_raw:         parseFloat(stockOnHand.toFixed(4)),
        // Nuevos campos
        opening_last_inv:          parseFloat(openingLastInv.toFixed(4)),
        purchase:                  parseFloat(purchase.toFixed(4)),
        sold,
        variance:                  parseFloat(variance.toFixed(4)),
        // Existentes
        reorder_point:             reorderPoint,
        par,
        case_size:                 caseSize,
        order_by:                  orderBy,
        suggested_order:           suggestedOrder,
        actual_order:              0,
        unit_price:                parseFloat(unitPrice.toFixed(4)),
        is_missing_from_inventory: !countedProductIds.has(product.id_products)
      });
    });

    res.json({
      success: true,
      data: {
        inventory_id:   inventoryId,
        current_date:   currentInvDate,
        prev_date:      prevInvDate,
        vendors:        Object.values(vendorGroups)
      }
    });

  } catch (error) {
    console.error('Error calculating order suggestions:', error);
    res.status(500).json({ message: 'Error calculating suggestions', error: error.message });
  }
};

// ============================================
// CREATE ORDER
// ============================================
const createOrder = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { storeId, vendorId, inventoryId, items, notes, createdBy } = req.body;

    if (!storeId || !vendorId || !items || items.length === 0) {
      await connection.rollback();
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const orderNumber = await generateOrderNumber(connection, storeId);

    let totalItems  = 0;
    let totalAmount = 0;
    items.forEach(item => {
      if (item.actual_order > 0) {
        totalItems  += 1;
        totalAmount += item.actual_order * item.unit_price;
      }
    });

    const [orderResult] = await connection.execute(
      `INSERT INTO orders (id_store, id_vendor, id_inventory, order_number, order_date, status, total_items, total_amount, notes, created_by)
       VALUES (?, ?, ?, ?, NOW(), 'Draft', ?, ?, ?, ?)`,
      [storeId, vendorId, inventoryId, orderNumber, totalItems, totalAmount, notes, createdBy]
    );

    const orderId = orderResult.insertId;

    for (const item of items) {
      if (item.actual_order > 0) {
        await connection.execute(
          `INSERT INTO order_items (id_order, id_product, stock_on_hand, reorder_point, par, suggested_order, actual_order, order_by, unit_price, total_price, is_missing_from_inventory)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
            item.id_product              ?? null,
            item.stock_on_hand           ?? 0,
            item.reorder_point           ?? 0,
            item.par                     ?? 0,
            item.suggested_order         ?? 0,
            item.actual_order            ?? 0,
            item.order_by                || null,
            item.unit_price              ?? 0,
            (item.actual_order * item.unit_price) || 0,
            item.is_missing_from_inventory ?? false
          ]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Order created successfully', data: { order_id: orderId, order_number: orderNumber } });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating order:', error);
    res.status(500).json({ message: 'Error creating order', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================
// GET ALL ORDERS
// ============================================
const getAllOrders = async (req, res) => {
  try {
    const { storeId, status } = req.query;
    let query = 'SELECT * FROM v_orders_with_details WHERE 1=1';
    const params = [];
    if (storeId) { query += ' AND id_stores = ?'; params.push(storeId); }
    if (status)  { query += ' AND status = ?';    params.push(status); }
    query += ' ORDER BY order_date DESC';
    const [orders] = await pool.execute(query, params);
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ message: 'Error fetching orders', error: error.message });
  }
};

// ============================================
// GET ORDER BY ID
// ============================================
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await pool.execute('SELECT * FROM v_orders_with_details WHERE id_orders = ?', [id]);
    if (orders.length === 0) return res.status(404).json({ message: 'Order not found' });
    const [items] = await pool.execute('SELECT * FROM v_order_items_with_products WHERE id_order = ?', [id]);
    res.json({ success: true, data: { order: orders[0], items } });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ message: 'Error fetching order', error: error.message });
  }
};

// ============================================
// SEND ORDER EMAIL
// ============================================
const sendOrderEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const emailConfig = req.body;

    console.log(`📧 Sending order ${id} with ${emailConfig.items?.length || 'unknown'} items`);

    const [orders] = await pool.execute('SELECT * FROM v_orders_with_details WHERE id_orders = ?', [id]);
    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }
    const order = orders[0];

    const [items] = await pool.execute(
      `SELECT 
        oi.actual_order,
        oi.order_by as unit,
        oi.unit_price,
        p.product_name,
        p.product_code
       FROM order_items oi
       INNER JOIN products p ON oi.id_product = p.id_products
       WHERE oi.id_order = ? AND oi.actual_order > 0
       ORDER BY p.product_name`,
      [id]
    );

    console.log(`📦 Order ${id} has ${items.length} items to send`);

    const emailData = {
      vendor_email: emailConfig.to || order.vendor_email,
      order_number: order.order_number,
      order_date:   order.order_date,
      store_name:   order.store_name,
      vendor_name:  order.vendor_name,
      items: items.map(item => ({
        product_code: item.product_code || '-',
        product_name: item.product_name,
        actual_order: item.actual_order,
        order_by:     item.unit || 'Unit',
        unit_price:   item.unit_price
      })),
      total_amount: parseFloat(order.total_amount) || 0,
      total_items:  order.total_items || items.length
    };

    await sendEmail(emailData);

    await pool.execute('UPDATE orders SET status = ?, sent_at = NOW() WHERE id_orders = ?', ['Sent', id]);

    console.log(`✅ Order ${id} sent successfully with ${items.length} items`);

    res.json({
      success: true,
      message: `Order email sent successfully to ${emailData.vendor_email}`,
      items_count:  items.length,
      order_number: order.order_number
    });

  } catch (error) {
    console.error('❌ Error sending order email:', error);

    if (error.message?.toLowerCase().includes('payload') ||
        error.message?.toLowerCase().includes('413') ||
        error.message?.toLowerCase().includes('large')) {
      return res.status(413).json({
        success: false,
        message: 'Order has too many items to send via email.',
        error: 'Payload too large',
        items_count: req.body.items?.length || 'unknown'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error sending email',
      error: error.message
    });
  }
};

// ============================================
// HELPER — normalizar fecha a string YYYY-MM-DD
// ============================================
const toDateString = (val) => {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return String(val).split('T')[0];
};

// ============================================
// GET AVAILABLE DATES FOR VIEW ORDERS SELECTOR
// ============================================
const getOrderDates = async (req, res) => {
  try {
    const { storeId, filterType } = req.query;

    if (!storeId) {
      return res.status(400).json({ message: 'Store ID is required' });
    }

    let query;
    if (filterType === 'inventory_date') {
      query = `
        SELECT 
          DATE(i.inventory_date) as date,
          COUNT(DISTINCT o.id_orders) as order_count
        FROM orders o
        LEFT JOIN inventories i ON o.id_inventory = i.id_inventories
        WHERE o.id_store = ?
          AND o.status IN ('Sent', 'Received')
          AND i.inventory_date IS NOT NULL
        GROUP BY DATE(i.inventory_date)
        ORDER BY DATE(i.inventory_date) DESC
      `;
    } else {
      query = `
        SELECT 
          DATE(o.sent_at) as date,
          COUNT(DISTINCT o.id_orders) as order_count
        FROM orders o
        WHERE o.id_store = ?
          AND o.status IN ('Sent', 'Received')
          AND o.sent_at IS NOT NULL
        GROUP BY DATE(o.sent_at)
        ORDER BY DATE(o.sent_at) DESC
      `;
    }

    const [dates] = await pool.execute(query, [storeId]);
    const formatted = dates.map(d => ({ ...d, date: toDateString(d.date) }));
    res.json({ success: true, data: formatted });
  } catch (error) {
    console.error('Error fetching order dates:', error);
    res.status(500).json({ message: 'Error fetching dates', error: error.message });
  }
};

// ============================================
// GET ORDERS FOR VIEW
// ============================================
const getOrdersForView = async (req, res) => {
  try {
    const { storeId, filterType, filterDate } = req.query;

    if (!storeId) {
      return res.status(400).json({ message: 'Store ID is required' });
    }

    let query = `
      SELECT 
        o.id_orders,
        o.order_number,
        o.order_date,
        o.sent_at,
        o.status,
        o.total_items,
        o.total_amount,
        v.vendor_name,
        v.email as vendor_email,
        DATE(i.inventory_date) as inventory_date
      FROM orders o
      INNER JOIN vendors v ON o.id_vendor = v.id_vendors
      LEFT JOIN inventories i ON o.id_inventory = i.id_inventories
      WHERE o.id_store = ?
        AND o.status IN ('Sent', 'Received')
    `;

    const params = [storeId];

    if (filterDate) {
      const cleanDate = toDateString(filterDate);
      if (filterType === 'inventory_date') {
        query += ` AND DATE(i.inventory_date) = ?`;
      } else {
        query += ` AND DATE(o.sent_at) = ?`;
      }
      params.push(cleanDate);
    }

    query += ` ORDER BY o.sent_at DESC`;

    const [orders] = await pool.execute(query, params);

    const ordersWithItems = await Promise.all(orders.map(async (order) => {
      const [items] = await pool.execute(
        `SELECT 
          oi.actual_order as quantity,
          oi.order_by as unit,
          p.product_name,
          p.product_code
         FROM order_items oi
         INNER JOIN products p ON oi.id_product = p.id_products
         WHERE oi.id_order = ? AND oi.actual_order > 0
         ORDER BY p.product_name`,
        [order.id_orders]
      );
      return { ...order, inventory_date: toDateString(order.inventory_date), items };
    }));

    res.json({ success: true, orders: ordersWithItems });
  } catch (error) {
    console.error('Error fetching orders for view:', error);
    res.status(500).json({ message: 'Error fetching orders', error: error.message });
  }
};

// ============================================
// DELETE ORDER
// ============================================
const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM orders WHERE id_orders = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ success: false, message: 'Error deleting order', error: error.message });
  }
};

module.exports = {
  getInventoriesForOrdering,
  calculateOrderSuggestions,
  createOrder,
  getAllOrders,
  getOrderById,
  sendOrderEmail,
  getOrderDates,
  getOrdersForView,
  deleteOrder
};