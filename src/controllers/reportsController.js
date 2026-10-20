const pool = require('../config/database');

// ============================================================================
// VARIANCE REPORT
// ----------------------------------------------------------------------------
// Cantidades (Opening, Purchase, Sold, Variance, Stock on Hand) calculadas con
// EXACTAMENTE la misma lógica de Ordering (calcStockUnits + toBaseGrams), para
// que un mismo inventario muestre los mismos valores en ambos módulos.
//
// El valor en dólares (Total) proviene del wholesale_value YA GUARDADO en
// inventory_items (la misma valuación que suma Inventories en total_ws_value),
// así el WS Total del reporte cuadra contra la pantalla de Inventories.
//
// Además de productos, el reporte incluye los PRE-BATCH (preps) contados en el
// inventario de esa fecha. Salen en el mismo formato de fila, con categoría y
// tipo "Pre-Batch" (igual que en Physical Inventory), y su Total también suma
// al WS Total (Inventories también incluye los preps en total_ws_value).
// ============================================================================

// ── Helpers de conversión (idénticos a ordersController) ────────────────────
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

// Stock en "unidades de contenedor" — copia exacta de la de Ordering.
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

// ── Preps (Pre-Batch) ───────────────────────────────────────────────────────
// Un prep se cuenta en su propia unidad de rendimiento (yield_unit). Cada fila
// guardada trae su quantity_type; si es una unidad de peso/volumen distinta al
// yield_unit se convierte (misma tabla de conversión de toBaseGrams). Si es
// 'Each' u otra unidad no convertible (Physical Inventory guarda los preps como
// 'Each'), la cantidad ya viene en unidades del yield y se toma tal cual.
const CONVERTIBLE_UNITS = ['g', 'kg', 'oz', 'lb', 'ml', 'L', 'Liter', 'Gallon', 'fl oz'];

const prepQtyInYieldUnit = (quantity, quantityType, yieldUnit) => {
  const qty = parseFloat(quantity) || 0;
  if (!quantityType || quantityType === yieldUnit) return qty;
  if (CONVERTIBLE_UNITS.includes(quantityType) && CONVERTIBLE_UNITS.includes(yieldUnit)) {
    const yieldBase = toBaseGrams(1, yieldUnit) || 1;
    return toBaseGrams(qty, quantityType) / yieldBase;
  }
  return qty;
};

const sumPrepQty = (items, yieldUnit) =>
  items.reduce((acc, it) => acc + prepQtyInYieldUnit(it.quantity, it.quantity_type, yieldUnit), 0);

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

    // ── Meta por producto + Total (wholesale_value guardado) ──────────────────
    //    Base: productos contados en el inventario de esa fecha (todas las
    //    locaciones). order_by / case_size / container_size_base_unit vienen de
    //    products / products_by_store, igual que Ordering.
    const [rows] = await pool.execute(
      `SELECT
         p.id_products                        AS id_product,
         ANY_VALUE(p.product_name)            AS product_name,
         ANY_VALUE(p.product_code)            AS product_code,
         ANY_VALUE(p.container_size)          AS container_size,
         ANY_VALUE(p.container_unit)          AS container_unit,
         ANY_VALUE(p.container_type)          AS container_type,
         ANY_VALUE(p.container_size_base_unit) AS container_size_base_unit,
         ANY_VALUE(p.case_size)               AS case_size,
         ANY_VALUE(p.wholesale_price)         AS wholesale_price,
         ANY_VALUE(c.category_name)           AS category_name,
         ANY_VALUE(pt.product_name)           AS product_type_name,
         ANY_VALUE(pbs.order_by_the)          AS order_by,
         SUM(ii.wholesale_value)              AS total_ws
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

    // ── Filas crudas del inventario ACTUAL (para calcStockUnits) ──────────────
    const [currentItems] = await pool.execute(
      `SELECT ii.id_product, ii.quantity_type, ii.quantity,
              ii.full_weight, ii.empty_weight, ii.net_weight
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       WHERE i.id_store = ? AND i.status = 'Locked'
         AND DATE(i.inventory_date) = ?
         AND ii.item_type = 'product'`,
      [storeId, currentDate]
    );
    const currentByProduct = {};
    currentItems.forEach(item => {
      const k = String(item.id_product);
      if (!currentByProduct[k]) currentByProduct[k] = [];
      currentByProduct[k].push(item);
    });

    // ── Filas crudas del inventario ANTERIOR (Opening) ────────────────────────
    const prevByProduct = {};
    if (prevDate) {
      const [prevItems] = await pool.execute(
        `SELECT ii.id_product, ii.quantity_type, ii.quantity,
                ii.full_weight, ii.empty_weight, ii.net_weight
         FROM inventory_items ii
         INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
         WHERE i.id_store = ? AND i.status = 'Locked'
           AND DATE(i.inventory_date) = ?
           AND ii.item_type = 'product'`,
        [storeId, prevDate]
      );
      prevItems.forEach(item => {
        const k = String(item.id_product);
        if (!prevByProduct[k]) prevByProduct[k] = [];
        prevByProduct[k].push(item);
      });
    }

    // ── PRE-BATCH: preps contados en el inventario de esa fecha ───────────────
    //    Base igual que con productos (todas las locaciones, solo Locked).
    //    Total = wholesale_value guardado, igual que en productos.
    const [prepRows] = await pool.execute(
      `SELECT
         pr.id_preps                    AS id_prep,
         ANY_VALUE(pr.prep_name)        AS prep_name,
         ANY_VALUE(pr.yield_quantity)   AS yield_quantity,
         ANY_VALUE(pr.yield_unit)       AS yield_unit,
         ANY_VALUE(pr.yield_unit_cost)  AS yield_unit_cost,
         SUM(ii.wholesale_value)        AS total_ws
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       INNER JOIN preps pr      ON ii.id_prep      = pr.id_preps
       WHERE i.id_store = ? AND i.status = 'Locked'
         AND DATE(i.inventory_date) = ?
         AND ii.item_type = 'prep'
       GROUP BY pr.id_preps`,
      [storeId, currentDate]
    );

    const [currentPrepItems] = await pool.execute(
      `SELECT ii.id_prep, ii.quantity_type, ii.quantity
       FROM inventory_items ii
       INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
       WHERE i.id_store = ? AND i.status = 'Locked'
         AND DATE(i.inventory_date) = ?
         AND ii.item_type = 'prep'`,
      [storeId, currentDate]
    );
    const currentPrepByPrep = {};
    currentPrepItems.forEach(item => {
      const k = String(item.id_prep);
      if (!currentPrepByPrep[k]) currentPrepByPrep[k] = [];
      currentPrepByPrep[k].push(item);
    });

    const prevPrepByPrep = {};
    if (prevDate) {
      const [prevPrepItems] = await pool.execute(
        `SELECT ii.id_prep, ii.quantity_type, ii.quantity
         FROM inventory_items ii
         INNER JOIN inventories i ON ii.id_inventory = i.id_inventories
         WHERE i.id_store = ? AND i.status = 'Locked'
           AND DATE(i.inventory_date) = ?
           AND ii.item_type = 'prep'`,
        [storeId, prevDate]
      );
      prevPrepItems.forEach(item => {
        const k = String(item.id_prep);
        if (!prevPrepByPrep[k]) prevPrepByPrep[k] = [];
        prevPrepByPrep[k].push(item);
      });
    }

    // ── Purchase (idéntico a Ordering) ────────────────────────────────────────
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

    // ── Armar filas (misma matemática que Ordering) ───────────────────────────
    let wsTotal = 0;
    const data = rows.map(r => {
      const key                   = String(r.id_product);
      const containerSizeBaseUnit = parseFloat(r.container_size_base_unit) || 1;
      const caseSize              = parseFloat(r.case_size) || 1;
      const orderBy               = r.order_by || r.container_type;
      const isCase                = orderBy === 'Case';

      // Stock actual y opening con la MISMA función que Ordering
      const stockOnHand = calcStockUnits(currentByProduct[key] || [], containerSizeBaseUnit);
      const openingRaw  = calcStockUnits(prevByProduct[key] || [], containerSizeBaseUnit);
      const purRaw      = purchaseMap[key] || 0;

      const stock    = isCase ? stockOnHand / caseSize : stockOnHand;
      const opening  = isCase ? openingRaw  / caseSize : openingRaw;
      const purchase = isCase ? purRaw      / caseSize : purRaw;
      const sold     = 0;
      const variance = stock - (opening + purchase) + sold;

      const wholesale = parseFloat(r.wholesale_price) || 0;
      const unitPrice = isCase ? wholesale : (caseSize > 0 ? wholesale / caseSize : wholesale);

      // Total = valor GUARDADO (canónico), no recalculado
      const total = parseFloat(r.total_ws) || 0;
      wsTotal += total;

      return {
        id_product:        r.id_product,
        id_prep:           null,
        item_type:         'product',
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
        order_by:          orderBy || null,
        case_size:         caseSize
      };
    });

    // ── Filas de PRE-BATCH (misma forma de fila que los productos) ────────────
    //    Los preps se producen internamente, no entran por factura: Purchase = 0.
    //    id_product va como "prep-<id>" para que cada fila siga teniendo una clave
    //    única (no choca con los ids numéricos de productos); el id real va en id_prep.
    const prepData = prepRows.map(r => {
      const key       = String(r.id_prep);
      const yieldUnit = r.yield_unit || '';

      const stock    = sumPrepQty(currentPrepByPrep[key] || [], yieldUnit);
      const opening  = sumPrepQty(prevPrepByPrep[key]    || [], yieldUnit);
      const purchase = 0;
      const sold     = 0;
      const variance = stock - (opening + purchase) + sold;

      const unitPrice = parseFloat(r.yield_unit_cost) || 0;   // costo por unidad de rendimiento
      const total     = parseFloat(r.total_ws) || 0;          // valor GUARDADO, igual que productos
      wsTotal += total;

      return {
        id_product:        `prep-${r.id_prep}`,
        id_prep:           r.id_prep,
        item_type:         'prep',
        product_name:      r.prep_name,
        product_code:      '',
        container_size:    r.yield_quantity,
        container_unit:    r.yield_unit,
        category_name:     'Pre-Batch',
        product_type_name: 'Pre-Batch',
        opening_last_inv:  parseFloat(opening.toFixed(4)),
        purchase:          parseFloat(purchase.toFixed(4)),
        sold,
        variance:          parseFloat(variance.toFixed(4)),
        stock_on_hand:     parseFloat(stock.toFixed(4)),
        unit_price:        parseFloat(unitPrice.toFixed(4)),
        total:             parseFloat(total.toFixed(4)),
        order_by:          r.yield_unit || null,
        case_size:         1
      };
    });

    const allRows = [...data, ...prepData];
    allRows.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));

    res.json({
      success: true,
      data: {
        rows:         allRows,
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