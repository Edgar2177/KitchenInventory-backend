const pool = require('../config/database');

// Obtener todas las recetas
const getAllRecipes = async (req, res) => {
  try {
    const { storeId } = req.query;

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: 'storeId is required'
      });
    }

    const [recipes] = await pool.execute(`
      SELECT 
        r.id_recipes as id,
        r.pos_id_number as posIdNumber,
        r.recipe_name as name,
        r.total_cost as totalCost,
        r.created_at as createdAt,
        COUNT(ri.id_recipe_ingredient) as ingredientCount
      FROM recipes r 
      LEFT JOIN recipe_ingredients ri 
        ON r.id_recipes = ri.id_recipe
      WHERE r.id_stores = ?
      GROUP BY r.id_recipes
      ORDER BY r.recipe_name
    `, [storeId]);

    res.json({
      success: true,
      data: recipes
    });
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching recipes',
      error: error.message
    });
  }
};

// Obtener una receta por ID con sus ingredientes y preparations
const getRecipeById = async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId } = req.query;

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: 'storeId is required'
      });
    }

    // Obtener receta
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
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }

    // Obtener ingredientes (solo productos)
    const [ingredients] = await pool.execute(`
      SELECT 
        ri.id_recipe_ingredient as id,
        ri.id_product as productId,
        p.product_name as productName,
        ri.quantity,
        ri.unit,
        ri.unit_cost as unitCost,
        ri.total_cost as totalCost
      FROM recipe_ingredients ri
      INNER JOIN products p ON ri.id_product = p.id_products
      WHERE ri.id_recipe = ? AND ri.item_type = 'product'
      ORDER BY p.product_name
    `, [id]);

    // Obtener preparations (pre-batch)
    const [preparations] = await pool.execute(`
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
        ri.total_cost as totalCost
      FROM recipe_ingredients ri
      INNER JOIN preps pr ON ri.id_prep = pr.id_preps
      WHERE ri.id_recipe = ? AND ri.item_type = 'prep'
      ORDER BY pr.prep_name
    `, [id]);

    const recipe = {
      ...recipes[0],
      ingredients,
      preparations
    };

    res.json({
      success: true,
      data: recipe
    });
  } catch (error) {
    console.error('Error fetching recipe:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching recipe',
      error: error.message
    });
  }
};

// Crear receta
const createRecipe = async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { storeId, posIdNumber, name, ingredients, preparations } = req.body;

    // Validaciones
    if (!storeId) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'storeId is required'
      });
    }

    if (!name || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Recipe name is required'
      });
    }

    const hasIngredients   = ingredients   && ingredients.length   > 0;
    const hasPreparations  = preparations  && preparations.length  > 0;

    if (!hasIngredients && !hasPreparations) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'At least one ingredient or preparation is required'
      });
    }

    // Verificar nombre único
    const [existing] = await connection.execute(
      'SELECT id_recipes FROM recipes WHERE id_stores = ? AND LOWER(TRIM(recipe_name)) = LOWER(TRIM(?))',
      [storeId, name]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: 'A recipe with that name already exists'
      });
    }

    // Calcular costo total (ingredientes + preparations)
    let totalCost = 0;
    (ingredients  || []).forEach(ing  => { totalCost += parseFloat(ing.totalCost)  || 0; });
    (preparations || []).forEach(prep => { totalCost += parseFloat(prep.totalCost) || 0; });

    // Insertar receta
    const [result] = await connection.execute(
      `INSERT INTO recipes (id_stores, pos_id_number, recipe_name, total_cost) 
       VALUES (?, ?, ?, ?)`,
      [storeId, posIdNumber || null, name.trim(), totalCost]
    );

    const recipeId = result.insertId;

    // Insertar ingredientes (productos)
    for (const ingredient of (ingredients || [])) {
      await connection.execute(
        `INSERT INTO recipe_ingredients 
         (id_recipe, id_product, item_type, quantity, unit, unit_cost, total_cost)
         VALUES (?, ?, 'product', ?, ?, ?, ?)`,
        [
          recipeId,
          ingredient.productId,
          ingredient.quantity,
          ingredient.unit,
          ingredient.unitCost,
          ingredient.totalCost
        ]
      );
    }

    // Insertar preparations (pre-batch)
    for (const prep of (preparations || [])) {
      const unitCost = parseFloat(prep.quantity) > 0
        ? (parseFloat(prep.totalCost) / parseFloat(prep.quantity)).toFixed(6)
        : 0;

      await connection.execute(
        `INSERT INTO recipe_ingredients 
         (id_recipe, id_prep, item_type, quantity, unit, unit_cost, total_cost)
         VALUES (?, ?, 'prep', ?, ?, ?, ?)`,
        [
          recipeId,
          prep.prepId,
          prep.quantity,
          prep.unit || 'Each',
          unitCost,
          prep.totalCost
        ]
      );
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Recipe created successfully',
      data: { id: recipeId }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating recipe:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating recipe',
      error: error.message
    });
  } finally {
    connection.release();
  }
};

// Actualizar receta
const updateRecipe = async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const { id } = req.params;
    // FIX: storeId ahora se extrae del body
    const { storeId, posIdNumber, name, ingredients, preparations } = req.body;

    // Validaciones
    if (!name || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Recipe name is required'
      });
    }

    const hasIngredients  = ingredients  && ingredients.length  > 0;
    const hasPreparations = preparations && preparations.length > 0;

    if (!hasIngredients && !hasPreparations) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'At least one ingredient or preparation is required'
      });
    }

    // FIX: verificar que la receta existe (query correcta)
    const [existing] = await connection.execute(
      'SELECT id_stores FROM recipes WHERE id_recipes = ?',
      [id]
    );

    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }

    // FIX: verificar nombre duplicado (excluyendo la receta actual)
    const [duplicate] = await connection.execute(
      'SELECT id_recipes FROM recipes WHERE id_stores = ? AND LOWER(TRIM(recipe_name)) = LOWER(TRIM(?)) AND id_recipes != ?',
      [existing[0].id_stores, name, id]
    );

    if (duplicate.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: 'A recipe with that name already exists'
      });
    }

    // FIX: calcular costo total incluyendo preparations
    let totalCost = 0;
    (ingredients  || []).forEach(ing  => { totalCost += parseFloat(ing.totalCost)  || 0; });
    (preparations || []).forEach(prep => { totalCost += parseFloat(prep.totalCost) || 0; });

    // Actualizar receta
    await connection.execute(
      `UPDATE recipes 
       SET pos_id_number = ?, recipe_name = ?, total_cost = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_recipes = ?`,
      [posIdNumber || null, name.trim(), totalCost, id]
    );

    // Eliminar todos los ingredientes existentes (productos y preps)
    await connection.execute(
      'DELETE FROM recipe_ingredients WHERE id_recipe = ?',
      [id]
    );

    // Insertar ingredientes (productos)
    for (const ingredient of (ingredients || [])) {
      await connection.execute(
        `INSERT INTO recipe_ingredients 
         (id_recipe, id_product, item_type, quantity, unit, unit_cost, total_cost)
         VALUES (?, ?, 'product', ?, ?, ?, ?)`,
        [
          id,
          ingredient.productId,
          ingredient.quantity,
          ingredient.unit,
          ingredient.unitCost,
          ingredient.totalCost
        ]
      );
    }

    // Insertar preparations (pre-batch)
    for (const prep of (preparations || [])) {
      const unitCost = parseFloat(prep.quantity) > 0
        ? (parseFloat(prep.totalCost) / parseFloat(prep.quantity)).toFixed(6)
        : 0;

      await connection.execute(
        `INSERT INTO recipe_ingredients 
         (id_recipe, id_prep, item_type, quantity, unit, unit_cost, total_cost)
         VALUES (?, ?, 'prep', ?, ?, ?, ?)`,
        [
          id,
          prep.prepId,
          prep.quantity,
          prep.unit || 'Each',
          unitCost,
          prep.totalCost
        ]
      );
    }

    await connection.commit();

    res.json({
      success: true,
      message: 'Recipe updated successfully'
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating recipe:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating recipe',
      error: error.message
    });
  } finally {
    connection.release();
  }
};

// Eliminar receta
const deleteRecipe = async (req, res) => {
  try {
    const { id } = req.params;

    // FIX: SQL corregido (tenía "AND id_recipes" colgado)
    const [result] = await pool.execute(
      'DELETE FROM recipes WHERE id_recipes = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }

    res.json({
      success: true,
      message: 'Recipe deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting recipe:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting recipe',
      error: error.message
    });
  }
};

module.exports = {
  getAllRecipes,
  getRecipeById,
  createRecipe,
  updateRecipe,
  deleteRecipe
};