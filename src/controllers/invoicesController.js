const pool = require('../config/database');
const { getRecipientsForType } = require('./notificationsController');
const { sendInvoiceDiscrepancyEmail } = require('../services/emailService');

// ============================================================
// GET ORDER DATES FOR INVOICE SELECTOR (dropdown de fechas)
// ============================================================
const getOrderDatesForInvoice = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const [dates] = await pool.execute(
      `SELECT 
        DATE(o.sent_at) as date,
        COUNT(DISTINCT o.id_orders) as order_count
       FROM orders o
       WHERE o.id_store = ?
         AND o.status = 'Sent'
         AND o.sent_at IS NOT NULL
       GROUP BY DATE(o.sent_at)
       ORDER BY DATE(o.sent_at) DESC`,
      [storeId]
    );

    const formatted = dates.map(d => ({
      ...d,
      date: d.date instanceof Date
        ? d.date.toISOString().split('T')[0]
        : String(d.date).split('T')[0]
    }));

    res.json({ success: true, data: formatted });
  } catch (error) {
    console.error('Error fetching order dates for invoice:', error);
    res.status(500).json({ success: false, message: 'Error fetching dates', error: error.message });
  }
};

// ============================================================
// GET ORDERS BY DATE FOR INVOICE
// ============================================================
const getOrdersByDateForInvoice = async (req, res) => {
  try {
    const { storeId, date } = req.query;
    if (!storeId || !date) return res.status(400).json({ success: false, message: 'storeId and date are required' });

    const [orders] = await pool.execute(
      `SELECT 
        o.id_orders,
        o.order_number,
        o.order_date,
        o.sent_at,
        o.total_items,
        o.total_amount,
        v.vendor_name,
        (SELECT id_invoice FROM invoices WHERE id_order = o.id_orders AND id_store = ? LIMIT 1) as id_invoice,
        (SELECT status    FROM invoices WHERE id_order = o.id_orders AND id_store = ? LIMIT 1) as invoice_status
       FROM orders o
       INNER JOIN vendors v ON o.id_vendor = v.id_vendors
       WHERE o.id_store = ?
         AND o.status = 'Sent'
         AND DATE(o.sent_at) = ?
       ORDER BY o.sent_at DESC`,
      [storeId, storeId, storeId, date]
    );

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Error fetching orders by date:', error);
    res.status(500).json({ success: false, message: 'Error fetching orders', error: error.message });
  }
};

// ============================================================
// GET ORDERS FOR INVOICE (legacy)
// ============================================================
const getOrdersForInvoice = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const [orders] = await pool.execute(
      `SELECT 
        o.id_orders,
        o.order_number,
        o.order_date,
        o.sent_at,
        o.total_items,
        o.total_amount,
        v.vendor_name,
        (SELECT id_invoice FROM invoices WHERE id_order = o.id_orders AND id_store = ? LIMIT 1) as id_invoice,
        (SELECT status    FROM invoices WHERE id_order = o.id_orders AND id_store = ? LIMIT 1) as invoice_status
       FROM orders o
       INNER JOIN vendors v ON o.id_vendor = v.id_vendors
       WHERE o.id_store = ?
         AND o.status = 'Sent'
       ORDER BY o.sent_at DESC`,
      [storeId, storeId, storeId]
    );

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Error fetching orders for invoice:', error);
    res.status(500).json({ success: false, message: 'Error fetching orders', error: error.message });
  }
};

// ============================================================
// GET INVOICE BY ORDER + STORE
// ============================================================
const getInvoiceByOrder = async (req, res) => {
  try {
    const { orderId, storeId, invoiceId } = req.query;

    // Modo no-order: buscar por invoiceId directamente
    if (invoiceId) {
      const [existing] = await pool.execute(
        `SELECT * FROM invoices WHERE id_invoice = ? AND id_store = ? LIMIT 1`,
        [invoiceId, storeId]
      );
      if (existing.length > 0) {
        const invoice = existing[0];
        const [items] = await pool.execute(
          `SELECT * FROM invoice_items WHERE id_invoice = ? ORDER BY is_extra ASC, product_name ASC`,
          [invoice.id_invoice]
        );
        return res.json({ success: true, data: { ...invoice, items } });
      }
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    if (!orderId || !storeId) return res.status(400).json({ success: false, message: 'orderId and storeId are required' });

    const [existing] = await pool.execute(
      `SELECT * FROM invoices WHERE id_order = ? AND id_store = ? LIMIT 1`,
      [orderId, storeId]
    );

    if (existing.length > 0) {
      const invoice = existing[0];
      const [items] = await pool.execute(
        `SELECT * FROM invoice_items WHERE id_invoice = ? ORDER BY is_extra ASC, product_name ASC`,
        [invoice.id_invoice]
      );
      return res.json({ success: true, data: { ...invoice, items } });
    }

    const [orderItems] = await pool.execute(
      `SELECT 
        oi.id_product,
        oi.actual_order   as ordered_qty,
        oi.order_by,
        oi.unit_price     as price_app,
        p.product_name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.wholesale_price
       FROM order_items oi
       INNER JOIN products p ON oi.id_product = p.id_products
       WHERE oi.id_order = ? AND oi.actual_order > 0
       ORDER BY p.product_name ASC`,
      [orderId]
    );

    const items = orderItems.map(item => ({
      id_invoice_item: null,
      id_product:      item.id_product,
      product_name:    item.product_name,
      product_code:    item.product_code,
      container_size:  item.container_size,
      container_unit:  item.container_unit,
      ordered_qty:     parseFloat(item.ordered_qty) || 0,
      received_qty:    null,
      price_app:       parseFloat(item.price_app || item.wholesale_price) || 0,
      price_invoice:   null,
      is_extra:        0
    }));

    res.json({
      success: true,
      data: {
        id_invoice:     null,
        id_order:       parseInt(orderId),
        id_store:       parseInt(storeId),
        invoice_number: null,
        status:         'Draft',
        total_amount:   0,
        items
      }
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ success: false, message: 'Error fetching invoice', error: error.message });
  }
};

// ============================================================
// SAVE INVOICE — soporta modo normal Y no-order + email en ambos
// ============================================================
const saveInvoice = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      orderId,
      storeId,
      vendorId,
      invoiceNumber,
      notes,
      items = [],
      createdBy,
      receiptUrl,
      receiptPublicId,
      noOrder = false
    } = req.body;

    // ── Validación ──────────────────────────────────────────
    if (!storeId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    if (!noOrder && !orderId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'orderId is required for normal invoices' });
    }

    if (noOrder && !vendorId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'vendorId is required for no-order invoices' });
    }

    // ── Calcular total ───────────────────────────────────────
    let totalAmount = 0;
    items.forEach(item => {
      const qty   = parseFloat(item.received_qty)  || 0;
      const price = parseFloat(item.price_invoice) || parseFloat(item.price_app) || 0;
      totalAmount += qty * price;
    });

    // ── Insertar o actualizar invoice ────────────────────────
    let invoiceId;

    if (noOrder) {
      // NO-ORDER: siempre crear uno nuevo
      const [result] = await connection.execute(
        `INSERT INTO invoices
           (id_order, id_store, id_vendor, invoice_number, status, total_amount, notes, created_by, receipt_url, receipt_public_id, no_order)
         VALUES (NULL, ?, ?, ?, 'Saved', ?, ?, ?, ?, ?, 1)`,
        [
          storeId,
          vendorId,
          invoiceNumber   || null,
          totalAmount,
          notes           || null,
          createdBy       || null,
          receiptUrl      || null,
          receiptPublicId || null
        ]
      );
      invoiceId = result.insertId;

    } else {
      // NORMAL: buscar si ya existe invoice para esa orden
      const [existing] = await connection.execute(
        'SELECT id_invoice FROM invoices WHERE id_order = ? AND id_store = ?',
        [orderId, storeId]
      );

      if (existing.length > 0) {
        invoiceId = existing[0].id_invoice;
        await connection.execute(
          `UPDATE invoices
             SET invoice_number    = ?,
                 status            = 'Saved',
                 total_amount      = ?,
                 notes             = ?,
                 receipt_url       = COALESCE(?, receipt_url),
                 receipt_public_id = COALESCE(?, receipt_public_id),
                 updated_at        = NOW()
           WHERE id_invoice = ?`,
          [invoiceNumber || null, totalAmount, notes || null, receiptUrl || null, receiptPublicId || null, invoiceId]
        );
        await connection.execute('DELETE FROM invoice_items WHERE id_invoice = ?', [invoiceId]);
      } else {
        const [result] = await connection.execute(
          `INSERT INTO invoices
             (id_order, id_store, invoice_number, status, total_amount, notes, created_by, receipt_url, receipt_public_id)
           VALUES (?, ?, ?, 'Saved', ?, ?, ?, ?, ?)`,
          [orderId, storeId, invoiceNumber || null, totalAmount, notes || null, createdBy || null, receiptUrl || null, receiptPublicId || null]
        );
        invoiceId = result.insertId;
      }
    }

    // ── Insertar items ───────────────────────────────────────
    const priceDiscrepancies    = [];
    const quantityDiscrepancies = [];

    for (const item of items) {
      const receivedQty  = item.received_qty  != null && item.received_qty  !== '' ? parseFloat(item.received_qty)  : null;
      const priceInvoice = item.price_invoice != null && item.price_invoice !== '' ? parseFloat(item.price_invoice) : null;
      const priceApp     = parseFloat(item.price_app)   || 0;
      const orderedQty   = parseFloat(item.ordered_qty) || 0;

      await connection.execute(
        `INSERT INTO invoice_items
           (id_invoice, id_product, product_name, product_code, container_size, container_unit,
            ordered_qty, received_qty, price_app, price_invoice, is_extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          item.id_product     || null,
          item.product_name,
          item.product_code   || null,
          item.container_size || null,
          item.container_unit || null,
          orderedQty,
          receivedQty,
          priceApp,
          priceInvoice,
          item.is_extra ? 1 : 0
        ]
      );

      // Actualizar precio si cambió
      if (item.id_product && priceInvoice !== null && Math.abs(priceInvoice - priceApp) > 0.001) {
        await connection.execute(
          'UPDATE products SET wholesale_price = ?, updated_at = NOW() WHERE id_products = ?',
          [priceInvoice, item.id_product]
        );
        priceDiscrepancies.push({
          product_name:  item.product_name,
          product_code:  item.product_code,
          price_app:     priceApp,
          price_invoice: priceInvoice
        });
      }

      // Discrepancias de cantidad solo aplican en modo normal
      if (!noOrder && !item.is_extra && receivedQty !== null && Math.abs(receivedQty - orderedQty) > 0.001) {
        quantityDiscrepancies.push({
          product_name: item.product_name,
          product_code: item.product_code,
          ordered_qty:  orderedQty,
          received_qty: receivedQty,
          difference:   parseFloat((receivedQty - orderedQty).toFixed(3))
        });
      }
    }

    // ── Marcar orden como Received (solo modo normal) ────────
    if (!noOrder && orderId) {
      await connection.execute(
        `UPDATE orders SET status = 'Received', received_at = NOW() WHERE id_orders = ?`,
        [orderId]
      );
    }

    await connection.commit();

    // ── EMAIL ────────────────────────────────────────────────
    // Modo normal  → manda solo si hay discrepancias de cantidad
    // Modo no-order → siempre manda
    const shouldSendEmail = noOrder || quantityDiscrepancies.length > 0;
    let notificationSent  = false;

    if (shouldSendEmail) {
      try {
        const notifType      = noOrder ? 'no_order_invoice' : 'invoice_discrepancy';
        let recipients       = await getRecipientsForType(storeId, notifType);

        // Fallback: si no hay recipients configurados para no_order_invoice
        // usar los mismos de invoice_discrepancy
        if (recipients.length === 0 && noOrder) {
          recipients = await getRecipientsForType(storeId, 'invoice_discrepancy');
        }

        if (recipients.length > 0) {

          if (noOrder) {
            // ── Email No Order ───────────────────────────────
            const [[vendor]] = await pool.execute(
              'SELECT vendor_name FROM vendors WHERE id_vendors = ?',
              [vendorId]
            );
            const [[store]] = await pool.execute(
              'SELECT store_name FROM stores WHERE id_stores = ?',
              [storeId]
            );

            await sendInvoiceDiscrepancyEmail({
              recipients,
              order_number:        null,
              vendor_name:         vendor?.vendor_name || 'Vendor',
              store_name:          store?.store_name   || 'Store',
              discrepancies:       [],
              price_discrepancies: priceDiscrepancies,
              invoice_number:      invoiceNumber || null,
              receipt_url:         receiptUrl    || null,
              total_amount:        totalAmount,
              no_order:            true,
              items: items.map(i => ({
                product_name:  i.product_name,
                product_code:  i.product_code,
                received_qty:  i.received_qty  != null && i.received_qty  !== '' ? parseFloat(i.received_qty)  : 0,
                price_invoice: i.price_invoice != null && i.price_invoice !== '' ? parseFloat(i.price_invoice) : parseFloat(i.price_app) || 0,
              }))
            });

          } else {
            // ── Email Discrepancias Orden Normal ─────────────
            const [[order]] = await pool.execute(
              `SELECT o.order_number, o.sent_at, v.vendor_name, s.store_name
                 FROM orders o
                 INNER JOIN vendors v ON o.id_vendor = v.id_vendors
                 INNER JOIN stores  s ON o.id_store  = s.id_stores
                WHERE o.id_orders = ?`,
              [orderId]
            );

            await sendInvoiceDiscrepancyEmail({
              recipients,
              order_number:        order?.order_number || `#${orderId}`,
              vendor_name:         order?.vendor_name  || 'Vendor',
              store_name:          order?.store_name   || 'Store',
              discrepancies:       quantityDiscrepancies,
              price_discrepancies: priceDiscrepancies,
              invoice_number:      invoiceNumber || null,
              receipt_url:         receiptUrl    || null,
              total_amount:        totalAmount,
              no_order:            false
            });
          }

          notificationSent = true;
        }
      } catch (emailErr) {
        console.error('⚠️  Error sending invoice notification:', emailErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Invoice saved successfully',
      data: {
        id_invoice:             invoiceId,
        total_amount:           totalAmount,
        price_discrepancies:    priceDiscrepancies,
        quantity_discrepancies: quantityDiscrepancies,
        notification_sent:      notificationSent
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error saving invoice:', error);
    res.status(500).json({ success: false, message: 'Error saving invoice', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// GET ALL INVOICES FOR A STORE — LEFT JOIN para incluir no-order
// ============================================================
const getAllInvoices = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const [invoices] = await pool.execute(
      `SELECT 
        i.id_invoice,
        i.invoice_number,
        i.status,
        i.total_amount,
        i.no_order,
        i.created_at,
        i.updated_at,
        i.receipt_url,
        o.id_orders,
        o.order_number,
        o.sent_at,
        COALESCE(v_order.vendor_name, v_direct.vendor_name) AS vendor_name,
        COUNT(ii.id_invoice_item) as total_items
       FROM invoices i
       LEFT JOIN orders        o         ON i.id_order  = o.id_orders
       LEFT JOIN vendors       v_order   ON o.id_vendor = v_order.id_vendors
       LEFT JOIN vendors       v_direct  ON i.id_vendor = v_direct.id_vendors
       LEFT JOIN invoice_items ii        ON i.id_invoice = ii.id_invoice
       WHERE i.id_store = ?
       GROUP BY i.id_invoice
       ORDER BY i.updated_at DESC`,
      [storeId]
    );

    res.json({ success: true, data: invoices });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching invoices', error: error.message });
  }
};

// ============================================================
// GET PRODUCTS FOR EXTRA ITEM PICKER
// ============================================================
const getProductsForStore = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const [products] = await pool.execute(
      `SELECT 
        p.id_products,
        p.product_name,
        p.product_code,
        p.container_size,
        p.container_unit,
        p.wholesale_price
       FROM products p
       INNER JOIN products_by_store pbs ON p.id_products = pbs.id_product
       WHERE pbs.id_store = ?
       ORDER BY p.product_name ASC`,
      [storeId]
    );

    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching products', error: error.message });
  }
};

// ============================================================
// UPLOAD RECEIPT IMAGE
// ============================================================
const uploadReceipt = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image provided' });

    const { invoiceId, orderId, storeId } = req.body;
    if (!storeId) return res.status(400).json({ success: false, message: 'storeId is required' });

    const { uploadReceiptImage } = require('../services/cloudinaryService');

    const timestamp = Date.now();
    const filename  = `receipt_store${storeId}_order${orderId || 'noorder'}_${timestamp}`;

    const result = await uploadReceiptImage(req.file.buffer, filename);

    // Si ya existe el invoice, guardar la URL directamente
    if (invoiceId) {
      await pool.execute(
        'UPDATE invoices SET receipt_url = ?, receipt_public_id = ? WHERE id_invoice = ?',
        [result.secure_url, result.public_id, invoiceId]
      );
    }

    res.json({
      success: true,
      message: 'Receipt uploaded successfully',
      data: {
        url:       result.secure_url,
        public_id: result.public_id
      }
    });
  } catch (error) {
    console.error('Error uploading receipt:', error);
    res.status(500).json({ success: false, message: 'Error uploading receipt', error: error.message });
  }
};

// ============================================================
// DELETE INVOICE
// ============================================================
const deleteInvoice = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { invoiceId, storeId } = req.body;
    if (!invoiceId || !storeId)
      return res.status(400).json({ success: false, message: 'invoiceId and storeId are required' });

    // Verificar que pertenece al store
    const [existing] = await connection.execute(
      'SELECT id_invoice, id_order, no_order FROM invoices WHERE id_invoice = ? AND id_store = ?',
      [invoiceId, storeId]
    );

    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const invoice = existing[0];

    // Borrar items primero
    await connection.execute('DELETE FROM invoice_items WHERE id_invoice = ?', [invoiceId]);

    // Borrar invoice
    await connection.execute('DELETE FROM invoices WHERE id_invoice = ?', [invoiceId]);

    // Si era orden normal, regresar la orden a status 'Sent'
    if (!invoice.no_order && invoice.id_order) {
      await connection.execute(
        `UPDATE orders SET status = 'Sent', received_at = NULL WHERE id_orders = ?`,
        [invoice.id_order]
      );
    }

    await connection.commit();

    res.json({ success: true, message: 'Invoice deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting invoice:', error);
    res.status(500).json({ success: false, message: 'Error deleting invoice', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// GET VENDORS FOR STORE (para el modal No-Order)
// ============================================================
const getVendorsForStore = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId)
      return res.status(400).json({ success: false, message: 'storeId is required' });
 
    const [vendors] = await pool.execute(
      `SELECT 
         v.id_vendors,
         v.vendor_name,
         v.contact_name,
         v.email,
         v.phone
       FROM vendors v
       ORDER BY v.vendor_name ASC`,
    );
 
    res.json({ success: true, data: vendors });
  } catch (error) {
    console.error('Error fetching vendors for store:', error);
    res.status(500).json({ success: false, message: 'Error fetching vendors', error: error.message });
  }
};

module.exports = {
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
};