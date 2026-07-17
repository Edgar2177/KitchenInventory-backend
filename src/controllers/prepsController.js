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
// GET PREP BY ID — incluye ingredientes y sub-preps con isMain
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
        yield_quantity                AS yieldQuantity,
        yield_unit                   AS yieldUnit,
        yield_unit_cost              AS yieldUnitCost,
        show_in_physical_inventory   AS showInPhysicalInventory,
        created_at                   AS createdAt
      FROM preps WHERE id_preps = ?`, [id]
    );

    if (preps.length === 0)
      return res.status(404).json({ success: false, message: 'Preparation not found' });

    // Ingredientes tipo product
    const [ingredients] = await pool.execute(`
      SELECT
        pi.id_prep_ingredient AS id,
        pi.id_product         AS productId,
        p.product_name        AS productName,
        pi.quantity,
        pi.unit,
        pi.unit_cost          AS unitCost,
        pi.total_cost         AS totalCost,
        pi.is_main            AS isMain
      FROM prep_ingredients pi
      INNER JOIN products p ON pi.id_product = p.id_products
      WHERE pi.id_prep = ? AND pi.item_type = 'product'
      ORDER BY p.product_name`, [id]
    );

    // Sub-preps tipo prep
    const [subPreps] = await pool.execute(`
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
        pi.is_main            AS isMain
      FROM prep_ingredients pi
      INNER JOIN preps pr ON pi.id_prep_ref = pr.id_preps
      WHERE pi.id_prep = ? AND pi.item_type = 'prep'
      ORDER BY pr.prep_name`, [id]
    );

    res.json({ success: true, data: { ...preps[0], ingredients, subPreps } });
  } catch (error) {
    console.error('Error fetching preparation:', error);
    res.status(500).json({ success: false, message: 'Error fetching preparation', error: error.message });
  }
};

// ============================================================
// CREATE PREP
// ============================================================
const createPrep = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      storeId, name, ingredients = [], subPreps = [], yieldQuantity, yieldUnit,
      showInPhysicalInventory
    } = req.body;

    if (!storeId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Store ID is required' });
    }
    if (!name?.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Preparation name is required' });
    }
    if (ingredients.length === 0 && subPreps.length === 0) {
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

    // Calcular costo total
    let totalCost = 0;
    ingredients.forEach(ing => { totalCost += parseFloat(ing.totalCost) || 0; });
    subPreps.forEach(sp     => { totalCost += parseFloat(sp.totalCost)  || 0; });

    const yieldUnitCost = yieldQuantity && parseFloat(yieldQuantity) > 0
      ? totalCost / parseFloat(yieldQuantity)
      : null;

    // showInPhysicalInventory: default true si no viene definido explícitamente
    const showInPI = showInPhysicalInventory === false ? 0 : 1;

    // Insertar prep
    const [result] = await connection.execute(
      `INSERT INTO preps (id_store, prep_name, total_cost, yield_quantity, yield_unit, yield_unit_cost, show_in_physical_inventory)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [storeId, name.trim(), totalCost, yieldQuantity ? parseFloat(yieldQuantity) : null, yieldUnit || null, yieldUnitCost, showInPI]
    );
    const prepId = result.insertId;

    // Insertar ingredientes (productos)
    for (const ing of ingredients) {
      await connection.execute(
        `INSERT INTO prep_ingredients
           (id_prep, id_product, item_type, quantity, unit, unit_cost, total_cost, is_main)
         VALUES (?, ?, 'product', ?, ?, ?, ?, ?)`,
        [prepId, ing.productId, ing.quantity, ing.unit, ing.unitCost, ing.totalCost, ing.isMain ? 1 : 0]
      );
    }

    // Insertar sub-preps
    for (const sp of subPreps) {
      // Verificar ciclo: el sub-prep no puede contener este prep
      const descendants = await getDescendantPrepIds(sp.prepId);
      if (descendants.has(prepId)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Circular reference detected: "${sp.prepName}" already uses this preparation`
        });
      }

      const unitCost = parseFloat(sp.quantity) > 0
        ? (parseFloat(sp.totalCost) / parseFloat(sp.quantity)).toFixed(6)
        : 0;

      await connection.execute(
        `INSERT INTO prep_ingredients
           (id_prep, id_prep_ref, item_type, quantity, unit, unit_cost, total_cost, is_main)
         VALUES (?, ?, 'prep', ?, ?, ?, ?, ?)`,
        [prepId, sp.prepId, sp.quantity, sp.unit || sp.baseUnit || 'Each', unitCost, sp.totalCost, sp.isMain ? 1 : 0]
      );
    }

    await connection.commit();
    res.status(201).json({ success: true, message: 'Preparation created successfully', data: { id: prepId } });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating preparation:', error);
    res.status(500).json({ success: false, message: 'Error creating preparation', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// UPDATE PREP
// ============================================================
const updatePrep = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const {
      name, ingredients = [], subPreps = [], yieldQuantity, yieldUnit,
      showInPhysicalInventory
    } = req.body;

    if (!name?.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Preparation name is required' });
    }
    if (ingredients.length === 0 && subPreps.length === 0) {
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

    // Calcular costo total
    let totalCost = 0;
    ingredients.forEach(ing => { totalCost += parseFloat(ing.totalCost) || 0; });
    subPreps.forEach(sp     => { totalCost += parseFloat(sp.totalCost)  || 0; });

    const yieldUnitCost = yieldQuantity && parseFloat(yieldQuantity) > 0
      ? totalCost / parseFloat(yieldQuantity)
      : null;

    // showInPhysicalInventory: default true si no viene definido explícitamente
    const showInPI = showInPhysicalInventory === false ? 0 : 1;

    // Actualizar prep
    await connection.execute(
      `UPDATE preps
       SET prep_name = ?, total_cost = ?, yield_quantity = ?, yield_unit = ?,
           yield_unit_cost = ?, show_in_physical_inventory = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_preps = ?`,
      [name.trim(), totalCost, yieldQuantity ? parseFloat(yieldQuantity) : null, yieldUnit || null, yieldUnitCost, showInPI, id]
    );

    // Limpiar ingredientes anteriores
    await connection.execute('DELETE FROM prep_ingredients WHERE id_prep = ?', [id]);

    // Insertar ingredientes (productos)
    for (const ing of ingredients) {
      await connection.execute(
        `INSERT INTO prep_ingredients
           (id_prep, id_product, item_type, quantity, unit, unit_cost, total_cost, is_main)
         VALUES (?, ?, 'product', ?, ?, ?, ?, ?)`,
        [id, ing.productId, ing.quantity, ing.unit, ing.unitCost, ing.totalCost, ing.isMain ? 1 : 0]
      );
    }

    // Insertar sub-preps
    for (const sp of subPreps) {
      // No puede usar a sí mismo
      if (parseInt(sp.prepId) === parseInt(id)) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'A preparation cannot reference itself' });
      }

      // Verificar ciclo
      const descendants = await getDescendantPrepIds(sp.prepId);
      if (descendants.has(parseInt(id))) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Circular reference detected: "${sp.prepName}" already uses this preparation`
        });
      }

      const unitCost = parseFloat(sp.quantity) > 0
        ? (parseFloat(sp.totalCost) / parseFloat(sp.quantity)).toFixed(6)
        : 0;

      await connection.execute(
        `INSERT INTO prep_ingredients
           (id_prep, id_prep_ref, item_type, quantity, unit, unit_cost, total_cost, is_main)
         VALUES (?, ?, 'prep', ?, ?, ?, ?, ?)`,
        [id, sp.prepId, sp.quantity, sp.unit || sp.baseUnit || 'Each', unitCost, sp.totalCost, sp.isMain ? 1 : 0]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Preparation updated successfully' });
  } catch (error) {
    await connection.rollback();
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