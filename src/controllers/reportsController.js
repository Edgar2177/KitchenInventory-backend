const pool = require('../config/database');

// ============================================================================
// VARIANCE REPORT
// ----------------------------------------------------------------------------
// Usa el wholesale_value YA GUARDADO en inventory_items (la misma valuación
// que suma Inventories en total_ws_value), en vez de recalcularlo. Así el
// WS Total del reporte cuadra EXACTO contra la pantalla de Inventories.
//
// Las columnas de cantidad (Opening, Purchase, Sold, Variance, Stock on Hand)
// se calculan con la misma lógica de Ordering, pero el valor en dólares (Total)
// proviene del dato guardado, no de un recálculo.
// ============================================================================

// Stock en "unidades de contenedor" a partir de una fila de inventory_items,
// replicando el CASE que ya usa el módulo de inventario para imprimir.
const STOCK_UNITS_SQL = `
  CASE
    WHEN ii.quantity_type IN ('Bottle','Can','Keg','Each','Box','Bag','Carton') THEN ii.quantity
    WHEN ii.quantity_type IN ('g','kg','oz','lb','ml','L','Liter','Gallon','fl oz') THEN
      CASE
        WHEN ii.net_weight > 0 AND ii.full_weight > 0 AND ii.empty_weight IS NOT NULL AND ii.empty_weight > 0 THEN
          (CASE ii.quantity_type
            WHEN 'kg'     THEN ii.quantity * 1000
            WHEN 'oz'     THEN ii.quantity * 28.3495
            WHEN 'lb'     THEN ii.quantity * 453.592
            WHEN 'L'      THEN ii.quantity * 1000
            WHEN 'Liter'  THEN ii.quantity * 1000
            WHEN 'Gallon' THEN ii.quantity * 3785.41
            WHEN 'fl oz'  THEN ii.quantity * 29.5735
            ELSE ii.quantity END
            - ii.empty_weight) / ii.net_weight
        ELSE ii.product_weight_grams / NULLIF(p.container_size_base_unit, 0)
      END
    ELSE ii.quantity
  END
`;

const getVarianceReport = async (req, res) => {
  try {
    const storeId     = req.query.storeId     || (req.body && req.body.storeId);
    const inventoryId = req.query.inventoryId || (req.body && req.body.inventoryId);

    if (!storeId || !inventoryId) {
      return res.status(400).json({ success: false, message: 'storeId and inventoryId are required' });
    }

    // ── Fecha del inventario seleccionado ─────────────────────────────────────
    const [[currRow]] = await pool.execute(
      'SELECT DATE(inventory_date) AS d FROM inventories WHERE id_inventories = ?',
      [inventoryId]
    );
    const currentDate = currRow ? currRow.d : null;
    if (!currentDate) {
      return res.status(404).json({ success: false, message: 'Inventory not found' });
    }

    // ── Fecha del inventario anterior ─────────────────────────────────────────
    const [[prevRow]] = await pool.execute(
      `SELECT DATE(inventory_date) AS d
       FROM inventories
       WHERE id_store = ? AND status = 'Locked' AND DATE(inventory_date) < ?
       ORDER BY inventory_date DESC
       LIMIT 1`,
      [storeId, currentDate]
    );
    const prevDate = prevRow ? prevRow.d : null;

    // ── Productos del inventario actual (todas las locaciones de esa fecha) ────
    //    total_ws = SUM(wholesale_value) GUARDADO  → valuación canónica
    //    stock_units = SUM(stock en unidades de contenedor)
    const [rows] = await pool.execute(
      `SELECT
         p.id_products                       AS id_product,
         ANY_VALUE(p.product_name)           AS product_name,
         ANY_VALUE(p.product_code)           AS product_code,
         ANY_VALUE(p.container_size)         AS container_size,
         ANY_VALUE(p.container_unit)         AS container_unit,
         ANY_VALUE(p.case_size)              AS case_size,
         ANY_VALUE(p.wholesale_price)        AS wholesale_price,
         ANY_VALUE(c.category_name)          AS category_name,
         ANY_VALUE(pt.product_name)          AS product_type_name,
         ANY_VALUE(pbs.order_by_the)         AS order_by,
         SUM(ii.wholesale_value)             AS total_ws,
         SUM(${STOCK_UNITS_SQL})             AS stock_units
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       INNER JOIN products p    ON ii.id_product   = p.id_products
       LEFT  JOIN categories c    ON p.id_category     = c.id_categories
       LEFT  JOIN product_types pt ON p.id_product_type = pt.id_product_types
       LEFT  JOIN products_by_store pbs ON p.id_products = pbs.id_product AND pbs.id_store = ?
       WHERE i.id_store = ? AND i.status = 'Locked'
         AND DATE(i.inventory_date) = ?
         AND ii.item_type = 'product'
       GROUP BY p.id_products`,
      [storeId, storeId, currentDate]
    );

    // ── Opening: stock del inventario anterior por producto ───────────────────
    const openingMap = {};
    if (prevDate) {
      const [openRows] = await pool.execute(
        `SELECT ii.id_product AS id_product, SUM(${STOCK_UNITS_SQL}) AS opening_units
         FROM inventory_items ii
         INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
         INNER JOIN products p    ON ii.id_product   = p.id_products
         WHERE i.id_store = ? AND i.status = 'Locked'
           AND DATE(i.inventory_date) = ?
           AND ii.item_type = 'product'
         GROUP BY ii.id_product`,
        [storeId, prevDate]
      );
      openRows.forEach(r => { openingMap[String(r.id_product)] = parseFloat(r.opening_units) || 0; });
    }

    // ── Purchase: compras entre inventario anterior y actual ──────────────────
    const purchaseMap = {};
    if (prevDate && currentDate) {
      try {
        const [pur] = await pool.execute(
          `SELECT ii.id_product AS id_product, SUM(ii.received_qty) AS qty
           FROM invoice_items ii
           INNER JOIN invoices inv ON ii.id_invoice = inv.id_invoice
           LEFT  JOIN orders o     ON inv.id_order  = o.id_orders
           WHERE inv.id_store = ? AND inv.status = 'Saved'
             AND ii.received_qty IS NOT NULL
             AND DATE(COALESCE(inv.invoice_date, o.sent_at, inv.created_at)) >= ?
             AND DATE(COALESCE(inv.invoice_date, o.sent_at, inv.created_at)) <  ?
           GROUP BY ii.id_product`,
          [storeId, prevDate, currentDate]
        );
        pur.forEach(r => { purchaseMap[String(r.id_product)] = parseFloat(r.qty) || 0; });
      } catch (e) {
        console.warn('Variance report — purchases error:', e.message);
      }
    }

    // ── Armar filas ───────────────────────────────────────────────────────────
    let wsTotal = 0;
    const data = rows.map(r => {
      const caseSize = parseFloat(r.case_size) || 1;
      const isCase   = r.order_by === 'Case';

      const stockRaw = parseFloat(r.stock_units) || 0;
      const openRaw  = openingMap[String(r.id_product)]   || 0;
      const purRaw   = purchaseMap[String(r.id_product)]  || 0;

      const stock    = isCase ? stockRaw / caseSize : stockRaw;
      const opening  = isCase ? openRaw  / caseSize : openRaw;
      const purchase = isCase ? purRaw   / caseSize : purRaw;
      const sold     = 0;
      const variance = stock - (opening + purchase) + sold;

      const wholesale = parseFloat(r.wholesale_price) || 0;
      const unitPrice = isCase ? wholesale : (caseSize > 0 ? wholesale / caseSize : wholesale);

      // Total = valor GUARDADO (canónico), no recalculado
      const total = parseFloat(r.total_ws) || 0;
      wsTotal += total;

      return {
        id_product:        r.id_product,
        product_name:      r.product_name,
        product_code:      r.product_code,
        container_size:    r.container_size,
        container_unit:    r.container_unit,
        category_name:     r.category_name || 'Uncategorized',
        product_type_name: r.product_type_name || 'Other',
        opening_last_inv:  parseFloat(opening.toFixed(4)),
        purchase:          parseFloat(purchase.toFixed(4)),
        sold,
        variance:          parseFloat(variance.toFixed(4)),
        stock_on_hand:     parseFloat(stock.toFixed(4)),
        unit_price:        parseFloat(unitPrice.toFixed(4)),
        total:             parseFloat(total.toFixed(4)),
        order_by:          r.order_by || null,
        case_size:         caseSize
      };
    });

    data.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));

    res.json({
      success: true,
      data: {
        rows:         data,
        ws_total:     parseFloat(wsTotal.toFixed(2)),
        prev_date:    prevDate,
        current_date: currentDate
      }
    });
  } catch (error) {
    console.error('Error building variance report:', error);
    res.status(500).json({ success: false, message: 'Error building variance report', error: error.message });
  }
};

module.exports = { getVarianceReport };