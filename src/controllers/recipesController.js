const pool = require('../config/database');

// ============================================================
// HELPER: normalizar el payload a UNA sola lista ordenada "items".
// El frontend nuevo manda body.items (productos, secciones y
// preparations intercalados en el orden final). Si llega un frontend
// viejo (ingredients + preparations), se reconstruye: primero
// ingredients (productos), luego preparations — como se veía antes.
// ============================================================
const buildOrderedItems = (body) => {
  if (Array.isArray(body.items) && body.items.length > 0) {
    return body.items.map(it => ({ ...it }));
  }
  const ingredients  = Array.isArray(body.ingredients)  ? body.ingredients  : [];
  const preparations = Array.isArray(body.preparations) ? body.preparations : [];
  return [
    ...ingredients.map(it => ({ ...it, itemType: it.itemType || 'product' })),
    ...preparations.map(p => ({ ...p, itemType: 'prep' }))
  ];
};

// ============================================================
// HELPER: insertar la lista unificada en recipe_ingredients.
// display_order = posición GLOBAL dentro del arreglo (1-indexed),
// sin importar el tipo. Devuelve el costo total acumulado.
// ============================================================
const insertRecipeItems = async (connection, recipeId, items) => {
  let totalCost = 0;
  let position  = 0;

  for (const raw of items) {
    const it = raw || {};

    if (it.itemType === 'section') {
      const label = (it.sectionLabel || '').trim();
      if (!label) continue; // no guardar secciones vacías
      position += 1;
      await connection.execute(
        `INSERT INTO recipe_ingredients
           (id_recipe, item_type, section_label, quantity, unit, unit_cost, total_cost, display_order)
         VALUES (?, 'section', ?, 0, '', 0, 0, ?)`,
        [recipeId, label, position]
      );
      continue;
    }

    if (it.itemType === 'prep') {
      const unitCost = parseFloat(it.quantity) > 0
        ? (parseFloat(it.totalCost) / parseFloat(it.quantity)).toFixed(6)
        : 0;
      position += 1;
      totalCost += parseFloat(it.totalCost) || 0;
      await connection.execute(
        `INSERT INTO recipe_ingredients
           (id_recipe, id_prep, item_type, quantity, unit, unit_cost, total_cost, display_order)
         VALUES (?, ?, 'prep', ?, ?, ?, ?, ?)`,
        [recipeId, it.prepId, it.quantity, it.unit || 'Each', unitCost, it.totalCost, position]
      );
      continue;
    }

    // itemType === 'product' (default)
    position += 1;
    totalCost += parseFloat(it.totalCost) || 0;
    await connection.execute(
      `INSERT INTO recipe_ingredients
         (id_recipe, id_product, item_type, quantity, unit, unit_cost, total_cost, display_order)
       VALUES (?, ?, 'product', ?, ?, ?, ?, ?)`,
      [recipeId, it.productId, it.quantity, it.unit, it.unitCost, it.totalCost, position]
    );
  }

  return totalCost;
};

// ============================================================
// GET ALL RECIPES
// ingredientCount excluye las filas de sección (subtítulos).
// ============================================================
const getAllRecipes = async (req, res) => {
  try {
    const { storeId } = req.query;

    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    const [recipes] = await pool.execute(`
      SELECT 
        r.id_recipes as id,
        r.pos_id_number as posIdNumber,
        r.recipe_name as name,
        r.total_cost as totalCost,
        r.created_at as createdAt,
        COUNT(CASE WHEN ri.item_type IN ('product','prep') THEN ri.id_recipe_ingredient END) as ingredientCount
      FROM recipes r 
      LEFT JOIN recipe_ingredients ri 
        ON r.id_recipes = ri.id_recipe
      WHERE r.id_stores = ?
      GROUP BY r.id_recipes
      ORDER BY r.recipe_name
    `, [storeId]);

    res.json({ success: true, data: recipes });
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({ success: false, message: 'Error fetching recipes', error: error.message });
  }
};

// ============================================================
// GET RECIPE BY ID
// Devuelve un ÚNICO arreglo "items" (product + section + prep)
// ordenado por display_order GLOBAL. Con detección de datos legacy:
// si hay display_order duplicados dentro de la receta (recetas
// viejas sin orden, todas NULL/0), usa el orden clásico
// (ingredients por nombre, luego preparations por nombre).
// Se siguen devolviendo ingredients y preparations por compat.
// ============================================================
const getRecipeById = async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId } = req.query;

    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    const [recipes] = await pool.execute(`
      SELECT 
        id_recipes as id,
        pos_id_number as posIdNumber,
        recipe_name as name,
        total_cost as totalCost,
        created_at as createdAt
      FROM recipes
      WHERE id_recipes = ? AND id_stores = ?
    `, [id, storeId]);

    if (recipes.length === 0) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }

    // Ingredientes (productos) — ordenados por display_order y nombre
    const [ingredientRows] = await pool.execute(`
      SELECT 
        ri.id_recipe_ingredient as id,
        ri.id_product as productId,
        p.product_name as productName,
        ri.quantity,
        ri.unit,
        ri.unit_cost as unitCost,
        ri.total_cost as totalCost,
        ri.display_order as displayOrder
      FROM recipe_ingredients ri
      INNER JOIN products p ON ri.id_product = p.id_products
      WHERE ri.id_recipe = ? AND ri.item_type = 'product'
      ORDER BY ri.display_order ASC, p.product_name ASC
    `, [id]);

    // Subtítulos de sección
    const [sectionRows] = await pool.execute(`
      SELECT 
        ri.id_recipe_ingredient as id,
        ri.section_label as sectionLabel,
        ri.display_order as displayOrder
      FROM recipe_ingredients ri
      WHERE ri.id_recipe = ? AND ri.item_type = 'section'
      ORDER BY ri.display_order ASC
    `, [id]);

    // Preparations (pre-batch) — ordenadas por display_order y nombre
    const [prepRows] = await pool.execute(`
      SELECT 
        ri.id_recipe_ingredient as id,
        ri.id_prep as prepId,
        pr.prep_name as prepName,
        pr.total_cost as prepCost,
        pr.yield_quantity as baseQuantity,
        pr.yield_unit as baseUnit,
        ri.quantity,
        ri.unit,
        ri.unit_cost as unitCost,
        ri.total_cost as totalCost,
        ri.display_order as displayOrder
      FROM recipe_ingredients ri
      INNER JOIN preps pr ON ri.id_prep = pr.id_preps
      WHERE ri.id_recipe = ? AND ri.item_type = 'prep'
      ORDER BY ri.display_order ASC, pr.prep_name ASC
    `, [id]);

    const products = ingredientRows.map(r => ({ ...r, itemType: 'product' }));
    const sections = sectionRows.map(r => ({ ...r, itemType: 'section' }));
    const preps    = prepRows.map(r => ({ ...r, itemType: 'prep' }));

    const byOrder = (a, b) =>
      (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || (a.id ?? 0) - (b.id ?? 0);

    // ── Detección legacy: display_order duplicado dentro de la receta ──
    const allRows  = [...products, ...sections, ...preps];
    const orders   = allRows.map(r => r.displayOrder ?? 0);
    const isLegacy = new Set(orders).size !== orders.length;

    let items;
    if (isLegacy) {
      // Orden clásico: product/section primero (ya vienen por nombre), luego prep
      items = [
        ...[...products, ...sections].sort(byOrder),
        ...[...preps].sort(byOrder)
      ];
    } else {
      items = allRows.sort(byOrder);
    }

    // Compat: derivar ingredients (product+section) y preparations
    const ingredients  = items.filter(it => it.itemType === 'product' || it.itemType === 'section');
    const preparations = items.filter(it => it.itemType === 'prep');

    res.json({ success: true, data: { ...recipes[0], items, ingredients, preparations } });
  } catch (error) {
    console.error('Error fetching recipe:', error);
    res.status(500).json({ success: false, message: 'Error fetching recipe', error: error.message });
  }
};

// ============================================================
// CREATE RECIPE
// El índice global de cada elemento dentro de "items" define su
// display_order (orden definido por el usuario vía drag & drop
// o flechas ↑/↓).
// ============================================================
const createRecipe = async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { storeId, posIdNumber, name } = req.body;
    const items = buildOrderedItems(req.body);

    if (!storeId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }
    if (!name || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Recipe name is required' });
    }

    const realItemsCount = items.filter(it => it.itemType === 'product' || it.itemType === 'prep').length;
    if (realItemsCount === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'At least one ingredient or preparation is required' });
    }

    // Nombre único
    const [existing] = await connection.execute(
      'SELECT id_recipes FROM recipes WHERE id_stores = ? AND LOWER(TRIM(recipe_name)) = LOWER(TRIM(?))',
      [storeId, name]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A recipe with that name already exists' });
    }

    // Costo total
    let totalCost = 0;
    items.forEach(it => { if (it.itemType === 'product' || it.itemType === 'prep') totalCost += parseFloat(it.totalCost) || 0; });

    const [result] = await connection.execute(
      `INSERT INTO recipes (id_stores, pos_id_number, recipe_name, total_cost) 
       VALUES (?, ?, ?, ?)`,
      [storeId, posIdNumber || null, name.trim(), totalCost]
    );
    const recipeId = result.insertId;

    await insertRecipeItems(connection, recipeId, items);

    await connection.commit();
    res.status(201).json({ success: true, message: 'Recipe created successfully', data: { id: recipeId } });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating recipe:', error);
    res.status(500).json({ success: false, message: 'Error creating recipe', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// UPDATE RECIPE
// ============================================================
const updateRecipe = async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const { posIdNumber, name } = req.body;
    const items = buildOrderedItems(req.body);

    if (!name || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Recipe name is required' });
    }

    const realItemsCount = items.filter(it => it.itemType === 'product' || it.itemType === 'prep').length;
    if (realItemsCount === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'At least one ingredient or preparation is required' });
    }

    const [existing] = await connection.execute(
      'SELECT id_stores FROM recipes WHERE id_recipes = ?',
      [id]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }

    const [duplicate] = await connection.execute(
      'SELECT id_recipes FROM recipes WHERE id_stores = ? AND LOWER(TRIM(recipe_name)) = LOWER(TRIM(?)) AND id_recipes != ?',
      [existing[0].id_stores, name, id]
    );
    if (duplicate.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A recipe with that name already exists' });
    }

    // Costo total
    let totalCost = 0;
    items.forEach(it => { if (it.itemType === 'product' || it.itemType === 'prep') totalCost += parseFloat(it.totalCost) || 0; });

    await connection.execute(
      `UPDATE recipes 
       SET pos_id_number = ?, recipe_name = ?, total_cost = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_recipes = ?`,
      [posIdNumber || null, name.trim(), totalCost, id]
    );

    await connection.execute('DELETE FROM recipe_ingredients WHERE id_recipe = ?', [id]);
    await insertRecipeItems(connection, id, items);

    await connection.commit();
    res.json({ success: true, message: 'Recipe updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating recipe:', error);
    res.status(500).json({ success: false, message: 'Error updating recipe', error: error.message });
  } finally {
    connection.release();
  }
};

// ============================================================
// DELETE RECIPE
// ============================================================
const deleteRecipe = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM recipes WHERE id_recipes = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }
    res.json({ success: true, message: 'Recipe deleted successfully' });
  } catch (error) {
    console.error('Error deleting recipe:', error);
    res.status(500).json({ success: false, message: 'Error deleting recipe', error: error.message });
  }
};

module.exports = { getAllRecipes, getRecipeById, createRecipe, updateRecipe, deleteRecipe };