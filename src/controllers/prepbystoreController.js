const pool = require('../config/database');

// ========================================
// PRE-BATCH BY STORE
// Cada prep pertenece a UNA sola tienda (no es global como los
// productos), así que Par y Reorder Point viven directo en la
// tabla preps. Este controlador solo lista y actualiza esos dos
// campos por prep — no crea ni asigna (los preps ya existen).
// ========================================

// ----------------------------------------
// LISTAR PREPS DE UNA TIENDA (con par / reorder_point)
// GET /prep-by-store/store/:storeId
// ----------------------------------------
const getPrepsByStore = async (req, res) => {
  try {
    const { storeId } = req.params;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    const [rows] = await pool.execute(
      `SELECT
         p.id_preps        AS id,
         p.prep_name       AS name,
         p.yield_quantity  AS yieldQuantity,
         p.yield_unit      AS yieldUnit,
         p.par             AS par,
         p.reorder_point   AS reorderPoint,
         ANY_VALUE(CASE WHEN pi.is_main = 1 THEN COALESCE(prod.product_name, pr2.prep_name) END) AS mainIngredientName
       FROM preps p
       LEFT JOIN prep_ingredients pi ON p.id_preps = pi.id_prep AND pi.is_main = 1
       LEFT JOIN products prod ON pi.id_product  = prod.id_products AND pi.item_type = 'product'
       LEFT JOIN preps    pr2  ON pi.id_prep_ref = pr2.id_preps     AND pi.item_type = 'prep'
       WHERE p.id_store = ?
         AND p.show_in_physical_inventory = 1
       GROUP BY p.id_preps
       ORDER BY p.prep_name`,
      [storeId]
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching preps by store:', error);
    res.status(500).json({ success: false, message: 'Error fetching preps by store', error: error.message });
  }
};

// ----------------------------------------
// ACTUALIZAR PAR / REORDER POINT DE UN PREP
// PUT /prep-by-store/:id
// ----------------------------------------
const updatePrepParReorder = async (req, res) => {
  try {
    const { id } = req.params;
    const { par, reorderPoint } = req.body;

    const parValue = (par !== undefined && par !== null && par !== '' && !isNaN(parseFloat(par)))
      ? parseFloat(par) : null;
    const reorderValue = (reorderPoint !== undefined && reorderPoint !== null && reorderPoint !== '' && !isNaN(parseFloat(reorderPoint)))
      ? parseFloat(reorderPoint) : null;

    const [result] = await pool.execute(
      'UPDATE preps SET par = ?, reorder_point = ? WHERE id_preps = ?',
      [parValue, reorderValue, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Preparation not found' });
    }

    res.json({ success: true, message: 'Preparation updated successfully' });
  } catch (error) {
    console.error('Error updating prep par/reorder:', error);
    res.status(500).json({ success: false, message: 'Error updating preparation', error: error.message });
  }
};

module.exports = {
  getPrepsByStore,
  updatePrepParReorder
};