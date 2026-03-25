const pool = require('../config/database');

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
// CALCULATE ORDER SUGGESTIONS
// ============================================
const calculateOrderSuggestions = async (req, res) => {
  try {
    const { inventoryId, storeId } = req.body;

    if (!inventoryId || !storeId) {
      return res.status(400).json({ message: 'Inventory ID and Store ID are required' });
    }

    // 1. Obtener todos los productos del store con sus vendors
    const [productsWithVendors] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.wholesale_price,
        pbs.par,
        pbs.reorder_point,
        pbs.order_by_the as order_by,
        v.id_vendors,
        v.vendor_name,
        v.email as vendor_email
      FROM products p
      INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
      LEFT JOIN vendors v ON p.id_vendor = v.id_vendors
      WHERE pbs.id_store = ?
      ORDER BY v.vendor_name, p.product_name`,
      [storeId]
    );

    // 2. Suma de stock por fecha exacta del inventario seleccionado
    const [inventoryStock] = await pool.execute(
      `SELECT
        ii.id_product,
        SUM(
          CASE
            WHEN ii.quantity_type IN ('Bottle', 'Can', 'Keg', 'Each') THEN ii.quantity
            WHEN ii.quantity_type IN ('g', 'kg', 'oz', 'lb') THEN
              CASE
                WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight > 0 THEN
                  ((ii.quantity - ii.empty_weight) / ii.net_weight)
                ELSE 0
              END
            ELSE 0
          END
        ) as stock_on_hand
      FROM inventory_items ii
      INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
      WHERE i.id_store = ?
        AND i.status = 'Locked'
        AND DATE(i.inventory_date) = (
          SELECT DATE(inventory_date)
          FROM inventories
          WHERE id_inventories = ?
        )
      GROUP BY ii.id_product`,
      [storeId, inventoryId]
    );

    const stockMap = {};
    inventoryStock.forEach(item => {
      stockMap[item.id_product] = parseFloat(item.stock_on_hand);
    });

    // 3. Calcular sugerencias por vendor
    const vendorGroups = {};

    productsWithVendors.forEach(product => {
      const vendorId = product.id_vendors || 'no-vendor';
      const vendorName = product.vendor_name || 'Sin Vendor';

      if (!vendorGroups[vendorId]) {
        vendorGroups[vendorId] = {
          vendor_id: product.id_vendors,
          vendor_name: vendorName,
          vendor_email: product.vendor_email,
          products: []
        };
      }

      const stockOnHand = stockMap[product.id_products] || 0;
      const reorderPoint = parseFloat(product.reorder_point) || 0;
      const par = parseFloat(product.par) || 0;

      let suggestedOrder = 0;
      if (stockOnHand <= reorderPoint) {
        suggestedOrder = Math.ceil(par - stockOnHand);
        if (suggestedOrder < 0) suggestedOrder = 0;
      }

      vendorGroups[vendorId].products.push({
        id_product: product.id_products,
        product_name: product.product_name,
        product_code: product.product_code,
        container_size: product.container_size,
        container_unit: product.container_unit,
        stock_on_hand: stockOnHand,
        reorder_point: reorderPoint,
        par: par,
        order_by: product.order_by,
        suggested_order: suggestedOrder,
        actual_order: suggestedOrder,
        unit_price: parseFloat(product.wholesale_price) || 0,
        is_missing_from_inventory: stockOnHand === 0
      });
    });

    res.json({
      success: true,
      data: { inventory_id: inventoryId, vendors: Object.values(vendorGroups) }
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
      return res.status(400).json({ message: 'Missing required fields' });
    }

    await connection.execute('CALL sp_generate_order_number(?, @order_number)', [storeId]);
    const [rows] = await connection.execute('SELECT @order_number as order_number');
    const orderNumber = rows[0];

    let totalItems = 0;
    let totalAmount = 0;
    items.forEach(item => {
      if (item.actual_order > 0) {
        totalItems += 1;
        totalAmount += item.actual_order * item.unit_price;
      }
    });

    const [orderResult] = await connection.execute(
      `INSERT INTO orders (id_store, id_vendor, id_inventory, order_number, order_date, status, total_items, total_amount, notes, created_by)
       VALUES (?, ?, ?, ?, NOW(), 'Draft', ?, ?, ?, ?)`,
      [storeId, vendorId, inventoryId, orderNumber.order_number, totalItems, totalAmount, notes, createdBy]
    );

    const orderId = orderResult.insertId;

    for (const item of items) {
      if (item.actual_order > 0) {
        await connection.execute(
          `INSERT INTO order_items (id_order, id_product, stock_on_hand, reorder_point, par, suggested_order, actual_order, order_by, unit_price, total_price, is_missing_from_inventory)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [orderId, item.id_product, item.stock_on_hand, item.reorder_point, item.par,
           item.suggested_order, item.actual_order, item.order_by, item.unit_price,
           item.actual_order * item.unit_price, item.is_missing_from_inventory]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Order created successfully', data: { order_id: orderId, order_number: orderNumber.order_number } });
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
const { sendOrderEmail: sendEmail } = require('../services/emailService');

const sendOrderEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const emailConfig = req.body;
    const [orders] = await pool.execute('SELECT * FROM v_orders_with_details WHERE id_orders = ?', [id]);
    if (orders.length === 0) return res.status(404).json({ message: 'Order not found' });
    const order = orders[0];
    const [items] = await pool.execute(
      'SELECT * FROM v_order_items_with_products WHERE id_order = ? AND actual_order > 0 ORDER BY product_name',
      [id]
    );
    const emailData = {
      vendor_email: emailConfig.to || order.vendor_email,
      order_number: order.order_number,
      order_date: order.order_date,
      store_name: order.store_name,
      vendor_name: order.vendor_name,
      items,
      total_amount: order.total_amount
    };
    await sendEmail(emailData);
    await pool.execute('UPDATE orders SET status = ?, sent_at = NOW() WHERE id_orders = ?', ['Sent', id]);
    res.json({ success: true, message: `Order email sent successfully to ${emailData.vendor_email}` });
  } catch (error) {
    console.error('Error sending order email:', error);
    res.status(500).json({ message: 'Error sending email', error: error.message });
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

    // Normalizar fechas a string YYYY-MM-DD para evitar problemas de timezone
    const formatted = dates.map(d => ({
      ...d,
      date: toDateString(d.date)
    }));

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
      // Truncar la fecha por si viene con timezone desde el frontend
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

    // Obtener items de cada orden y normalizar fechas
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
      return {
        ...order,
        inventory_date: toDateString(order.inventory_date),
        items
      };
    }));

    res.json({ success: true, orders: ordersWithItems });
  } catch (error) {
    console.error('Error fetching orders for view:', error);
    res.status(500).json({ message: 'Error fetching orders', error: error.message });
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
  getOrdersForView
};