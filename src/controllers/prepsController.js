const pool = require('../config/database');

// ============================================================
// HELPER: obtener todos los prep_ids que usa un prep (recursivo)
// Para detectar ciclos antes de guardar
// ============================================================
const getDescendantPrepIds = async (prepId, visited = new Set()) => {
  if (visited.has(prepId)) return visited;
  visited.add(prepId);

  const [rows] = await pool.execute(
    `SELECT id_prep_ref FROM prep_ingredients 
     WHERE id_prep = ? AND item_type = 'prep' AND id_prep_ref IS NOT NULL`,
    [prepId]
  );

  for (const row of rows) {
    await getDescendantPrepIds(row.id_prep_ref, visited);
  }

  return visited;
};

// ============================================================
// HELPER: normalizar el payload a UNA sola lista ordenada "items".
// El frontend nuevo manda body.items (productos, secciones y
// sub-preps intercalados en el orden final que definió el usuario).
// Si llega un frontend viejo (solo ingredients + subPreps), se
// reconstruye la lista: primero ingredients, luego subPreps —
// exactamente como se veía antes de la unificación.
// ============================================================
const buildOrderedItems = (body) => {
  if (Array.isArray(body.items) && body.items.length > 0) {
    return body.items.map(it => ({ ...it }));
  }
  const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
  const subPreps    = Array.isArray(body.subPreps)    ? body.subPreps    : [];
  return [
    ...ingredients.map(it => ({ ...it })),
    ...subPreps.map(sp => ({ ...sp, itemType: 'prep' }))
  ];
};

// ============================================================
// GET ALL PREPS
// ============================================================
const getAllPreps = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) return res.status(400).json({ success: false, message: 'Store ID is required' });

    const [preps] = await pool.execute(`
      SELECT
        p.id_preps                        AS id,
        p.prep_name                       AS name,
        p.total_cost                      AS totalCost,
        p.yield_quantity                  AS yieldQuantity,
        p.yield_unit                      AS yieldUnit,
        p.yield_unit_cost                 AS yieldUnitCost,
        p.show_in_physical_inventory      AS showInPhysicalInventory,
        p.created_at                      AS createdAt,
        COUNT(pi.id_prep_ingredient)      AS ingredientCount,
        ANY_VALUE(main_ing.main_name)     AS mainIngredientName,
        ANY_VALUE(main_ing.main_qty)      AS mainIngredientQty,
        ANY_VALUE(main_ing.main_unit)     AS mainIngredientUnit
      FROM preps p
      LEFT JOIN prep_ingredients pi ON p.id_preps = pi.id_prep
      LEFT JOIN (
        SELECT
          pi2.id_prep,
          COALESCE(prod.product_name, pr2.prep_name) AS main_name,
          pi2.quantity                               AS main_qty,
          pi2.unit                                   AS main_unit
        FROM prep_ingredients pi2
        LEFT JOIN products prod ON pi2.id_product  = prod.id_products AND pi2.item_type = 'product'
        LEFT JOIN preps    pr2  ON pi2.id_prep_ref = pr2.id_preps     AND pi2.item_type = 'prep'
        WHERE pi2.is_main = 1
      ) main_ing ON p.id_preps = main_ing.id_prep
      WHERE p.id_store = ?
      GROUP BY p.id_preps
      ORDER BY p.prep_name`, [storeId]
    );

    res.json({ success: true, data: preps });
  } catch (error) {
    console.error('Error fetching preparations:', error);
    res.status(500).json({ success: false, message: 'Error fetching preparations', error: error.message });
  }
};

// ============================================================
// GET PREP BY ID
// Devuelve un ÚNICO arreglo "items" (productos + secciones +
// sub-preps) ordenado por display_order GLOBAL, para que el
// frontend renderice todo intercalado tal como se guardó.
//
// COMPATIBILIDAD CON DATOS LEGACY:
// Los preps guardados antes de la unificación tienen display_order
// que arranca en 1 tanto para ingredients como para sub-preps (se
// numeraban por separado), o sea que hay valores DUPLICADOS dentro
// del mismo prep. Si detectamos duplicados, usamos el orden clásico
// (primero product/section por su display_order, luego prep por su
// display_order). Si NO hay duplicados (datos nuevos con orden
// global único), ordenamos directo por display_order.
//
// Se siguen devolviendo también "ingredients" y "subPreps" por
// compatibilidad con cualquier consumidor previo.
// ============================================================
const getPrepById = async (req, res) => {
  try {
    const { id } = req.params;

    const [preps] = await pool.execute(`
      SELECT
        id_preps                     AS id,
        id_store                     AS storeId,
        prep_name                    AS name,
        total_cost                   AS totalCost,
        yield_quantity               AS yieldQuantity,
        yield_unit                   AS yieldUnit,
        yield_unit_cost              AS yieldUnitCost,
        to_prepare_qty               AS toPrepareQty,
        show_in_physical_inventory   AS showInPhysicalInventory,
        instructions                 AS instructions,
        created_at                   AS createdAt
      FROM preps WHERE id_preps = ?`, [id]
    );

    if (preps.length === 0)
      return res.status(404).json({ success: false, message: 'Preparation not found' });

    // Ingredientes tipo product
    const [ingredientRows] = await pool.execute(`
      SELECT
        pi.id_prep_ingredient AS id,
        pi.id_product         AS productId,
        p.product_name        AS productName,
        pi.quantity,
        pi.unit,
        pi.unit_cost          AS unitCost,
        pi.total_cost         AS totalCost,
        pi.is_main            AS isMain,
        pi.display_order      AS displayOrder
      FROM prep_ingredients pi
      INNER JOIN products p ON pi.id_product = p.id_products
      WHERE pi.id_prep = ? AND pi.item_type = 'product'`, [id]
    );

    // Subtítulos de sección (ej. "Cocido", "Crudo")
    const [sectionRows] = await pool.execute(`
      SELECT
        pi.id_prep_ingredient AS id,
        pi.section_label      AS sectionLabel,
        pi.display_order      AS displayOrder
      FROM prep_ingredients pi
      WHERE pi.id_prep = ? AND pi.item_type = 'section'`, [id]
    );

    // Sub-preps tipo prep
    const [subPrepRows] = await pool.execute(`
      SELECT
        pi.id_prep_ingredient AS id,
        pi.id_prep_ref        AS prepId,
        pr.prep_name          AS prepName,
        pr.total_cost         AS prepCost,
        pr.yield_quantity     AS baseQuantity,
        pr.yield_unit         AS baseUnit,
        pi.quantity,
        pi.unit,
        pi.unit_cost          AS unitCost,
        pi.total_cost         AS totalCost,
        pi.is_main            AS isMain,
        pi.display_order      AS displayOrder
      FROM prep_ingredients pi
      INNER JOIN preps pr ON pi.id_prep_ref = pr.id_preps
      WHERE pi.id_prep = ? AND pi.item_type = 'prep'`, [id]
    );

    const products = ingredientRows.map(r => ({ ...r, itemType: 'product' }));
    const sections = sectionRows.map(r => ({ ...r, itemType: 'section' }));
    const subPreps = subPrepRows.map(r => ({ ...r, itemType: 'prep' }));

    const byOrder = (a, b) =>
      (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || (a.id ?? 0) - (b.id ?? 0);

    // ── Detección de datos legacy: display_order duplicado dentro del prep ──
    const allRows   = [...products, ...sections, ...subPreps];
    const orders    = allRows.map(r => r.displayOrder ?? 0);
    const isLegacy  = new Set(orders).size !== orders.length;

    let items;
    if (isLegacy) {
      // Orden clásico: product/section primero, luego sub-preps
      items = [
        ...[...products, ...sections].sort(byOrder),
        ...[...subPreps].sort(byOrder)
      ];
    } else {
      // Orden global único: respetar el intercalado real
      items = allRows.sort(byOrder);
    }

    // Compat: derivar ingredients (product+section) y subPreps del orden final
    const ingredients = items.filter(it => it.itemType === 'product' || it.itemType === 'section');
    const subPrepsOut = items.filter(it => it.itemType === 'prep');

    res.json({ success: true, data: { ...preps[0], items, ingredients, subPreps: subPrepsOut } });
  } catch (error) {
    console.error('Error fetching preparation:', error);
    res.status(500).json({ success: false, message: 'Error fetching preparation', error: error.message });
  }
};

// ============================================================
// HELPER: insertar la lista unificada de items en prep_ingredients.
// display_order = posición GLOBAL dentro del arreglo (1-indexed),
// sin importar el tipo. Así productos y sub-preps comparten una
// sola secuencia de orden y el intercalado se persiste tal cual.
// Devuelve el costo total acumulado.
// ============================================================
const insertPrepItems = async (connection, prepId, items) => {
  let totalCost = 0;
  let position  = 0;

  for (const raw of items) {
    const it = raw || {};

    if (it.itemType === 'section') {
      const label = (it.sectionLabel || '').trim();
      if (!label) continue; // no guardar secciones vacías
      position += 1;
      await connection.execute(
        `INSERT INTO prep_ingredients
           (id_prep, item_type, section_label, quantity, unit, unit_cost, total_cost, is_main, display_order)
         VALUES (?, 'section', ?, 0, '', 0, 0, 0, ?)`,
        [prepId, label, position]
      );
      continue;
    }

    if (it.itemType === 'prep') {
      // Verificar ciclo: el sub-prep no puede contener este prep
      const descendants = await getDescendantPrepIds(it.prepId);
      if (descendants.has(parseInt(prepId))) {
        const err = new Error(`Circular reference detected: "${it.prepName}" already uses this preparation`);
        err.circular = true;
        throw err;
      }
      const unitCost = parseFloat(it.quantity) > 0
        ? (parseFloat(it.totalCost) / parseFloat(it.quantity)).toFixed(6)
        : 0;
      position += 1;
      totalCost += parseFloat(it.totalCost) || 0;
      await connection.execute(
        `INSERT INTO prep_ingredients
           (id_prep, id_prep_ref, item_type, quantity, unit, unit_cost, total_cost, is_main, display_order)
         VALUES (?, ?, 'prep', ?, ?, ?, ?, ?, ?)`,
        [prepId, it.prepId, it.quantity, it.unit || it.baseUnit || 'Each', unitCost, it.totalCost, it.isMain ? 1 : 0, position]
      );
      continue;
    }

    // itemType === 'product' (default)
    position += 1;
    totalCost += parseFloat(it.totalCost) || 0;
    await connection.execute(
      `INSERT INTO prep_ingredients
         (id_prep, id_product, item_type, quantity, unit, unit_cost, total_cost, is_main, display_order)
       VALUES (?, ?, 'product', ?, ?, ?, ?, ?, ?)`,
      [prepId, it.productId, it.quantity, it.unit, it.unitCost, it.totalCost, it.isMain ? 1 : 0, position]
    );
  }

  return totalCost;
};

// ============================================================
// CREATE PREP
// El orden en el que llega el arreglo unificado "items" (definido
// por el usuario en el frontend vía drag & drop o flechas ↑/↓) es
// lo que se persiste en display_order — el índice global ES la
// posición a guardar.
// ============================================================
const createPrep = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { storeId, name, yieldQuantity, yieldUnit, showInPhysicalInventory, instructions, toPrepareQty } = req.body;
    const items = buildOrderedItems(req.body);

    if (!storeId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Store ID is required' });
    }
    if (!name?.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Preparation name is required' });
    }
    const realItemsCount = items.filter(it => it.itemType === 'product' || it.itemType === 'prep').length;
    if (realItemsCount === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'At least one ingredient or sub-preparation is required' });
    }

    // Nombre único por store
    const [existing] = await connection.execute(
      'SELECT id_preps FROM preps WHERE LOWER(TRIM(prep_name)) = LOWER(TRIM(?)) AND id_store = ?',
      [name, storeId]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A preparation with that name already exists in this store' });
    }

    // Costo total (se recalcula de forma exacta al insertar)
    let totalCost = 0;
    items.forEach(it => { if (it.itemType === 'product' || it.itemType === 'prep') totalCost += parseFloat(it.totalCost) || 0; });

    const yieldUnitCost = yieldQuantity && parseFloat(yieldQuantity) > 0
      ? totalCost / parseFloat(yieldQuantity)
      : null;

    const showInPI = showInPhysicalInventory === false ? 0 : 1;
    const instructionsValue = instructions && instructions.trim() ? instructions.trim() : null;
    const toPrepareValue = (toPrepareQty !== undefined && toPrepareQty !== null && toPrepareQty !== '' && !isNaN(parseFloat(toPrepareQty)))
      ? parseFloat(toPrepareQty) : null;

    // Insertar prep
    const [result] = await connection.execute(
      `INSERT INTO preps (id_store, prep_name, total_cost, yield_quantity, yield_unit, yield_unit_cost, to_prepare_qty, show_in_physical_inventory, instructions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [storeId, name.trim(), totalCost, yieldQuantity ? parseFloat(yieldQuantity) : null, yieldUnit || null, yieldUnitCost, toPrepareValue, showInPI, instructionsValue]
    );
    const prepId = result.insertId;

    // Insertar todos los items con display_order global
    await insertPrepItems(connection, prepId, items);

    await connection.commit();
    res.status(201).json({ success: true, message: 'Preparation created successfully', data: { id: prepId } });
  } catch (error) {
    await connection.rollback();
    if (error.circular) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Error creating preparation:', error);
    res.status(500).json({ success: false, message: 'Error creating preparation', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// UPDATE PREP
// Mismo criterio que createPrep: el índice global de cada elemento
// dentro de "items" define su display_order.
// ============================================================
const updatePrep = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const { name, yieldQuantity, yieldUnit, showInPhysicalInventory, instructions, toPrepareQty } = req.body;
    const items = buildOrderedItems(req.body);

    if (!name?.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Preparation name is required' });
    }
    const realItemsCount = items.filter(it => it.itemType === 'product' || it.itemType === 'prep').length;
    if (realItemsCount === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'At least one ingredient or sub-preparation is required' });
    }

    const [existing] = await connection.execute(
      'SELECT id_store FROM preps WHERE id_preps = ?', [id]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Preparation not found' });
    }

    const storeId = existing[0].id_store;

    const [duplicate] = await connection.execute(
      'SELECT id_preps FROM preps WHERE LOWER(TRIM(prep_name)) = LOWER(TRIM(?)) AND id_store = ? AND id_preps != ?',
      [name, storeId, id]
    );
    if (duplicate.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A preparation with that name already exists in this store' });
    }

    // Validar auto-referencia entre sub-preps antes de tocar nada
    for (const it of items) {
      if (it.itemType === 'prep' && parseInt(it.prepId) === parseInt(id)) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'A preparation cannot reference itself' });
      }
    }

    // Costo total
    let totalCost = 0;
    items.forEach(it => { if (it.itemType === 'product' || it.itemType === 'prep') totalCost += parseFloat(it.totalCost) || 0; });

    const yieldUnitCost = yieldQuantity && parseFloat(yieldQuantity) > 0
      ? totalCost / parseFloat(yieldQuantity)
      : null;

    const showInPI = showInPhysicalInventory === false ? 0 : 1;
    const instructionsValue = instructions && instructions.trim() ? instructions.trim() : null;
    const toPrepareValue = (toPrepareQty !== undefined && toPrepareQty !== null && toPrepareQty !== '' && !isNaN(parseFloat(toPrepareQty)))
      ? parseFloat(toPrepareQty) : null;

    // Actualizar prep
    await connection.execute(
      `UPDATE preps
       SET prep_name = ?, total_cost = ?, yield_quantity = ?, yield_unit = ?,
           yield_unit_cost = ?, to_prepare_qty = ?, show_in_physical_inventory = ?, instructions = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_preps = ?`,
      [name.trim(), totalCost, yieldQuantity ? parseFloat(yieldQuantity) : null, yieldUnit || null, yieldUnitCost, toPrepareValue, showInPI, instructionsValue, id]
    );

    // Limpiar y re-insertar todo con display_order global
    await connection.execute('DELETE FROM prep_ingredients WHERE id_prep = ?', [id]);
    await insertPrepItems(connection, id, items);

    await connection.commit();
    res.json({ success: true, message: 'Preparation updated successfully' });
  } catch (error) {
    await connection.rollback();
    if (error.circular) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Error updating preparation:', error);
    res.status(500).json({ success: false, message: 'Error updating preparation', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// DELETE PREP
// ============================================================
const deletePrep = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM preps WHERE id_preps = ?', [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Preparation not found' });
    res.json({ success: true, message: 'Preparation deleted successfully' });
  } catch (error) {
    console.error('Error deleting preparation:', error);
    res.status(500).json({ success: false, message: 'Error deleting preparation', error: error.message });
  }
};

module.exports = { getAllPreps, getPrepById, createPrep, updatePrep, deletePrep };