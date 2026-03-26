const pool = require('../config/database');
const XLSX = require('xlsx');

// ========================================
// OBTENER TODOS LOS PRODUCTOS POR TIENDA
// ========================================
const getAllProductsByStore = async (req, res) => {
  try {
    const query = `
      SELECT 
        ps.id_product_store as id,
        ps.id_product as productId,
        p.product_name as productName,
        p.product_code as productCode,
        p.container_type as containerType,
        ps.id_store as storeId,
        s.store_name as storeName,
        ps.par as par,
        ps.reorder_point as reorderPoint,
        ps.order_by_the as orderByThe,
        ps.created_at as createdAt
      FROM products_by_store ps
      INNER JOIN products p ON ps.id_product = p.id_products
      INNER JOIN stores s ON ps.id_store = s.id_stores
      ORDER BY s.store_name, p.product_name
    `;
    const [rows] = await pool.execute(query, []);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error al obtener productos por tienda:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los productos por tienda', error: error.message });
  }
};

// ========================================
// OBTENER PRODUCTOS DE UNA TIENDA ESPECÍFICA
// ========================================
const getProductsByStoreId = async (req, res) => {
  try {
    const { storeId } = req.params;
    const query = `
      SELECT 
        ps.id_product_store as id,
        ps.id_product as productId,
        p.product_name as productName,
        p.product_code as productCode,
        p.container_size as containerSize,
        p.container_unit as containerUnit,
        p.container_type as containerType,
        p.case_size as caseSize,
        p.wholesale_price as wholesalePrice,
        p.full_weight_base_unit as fullWeightBaseUnit,
        p.empty_weight_base_unit as emptyWeightBaseUnit,
        c.category_name as categoryName,
        ps.par as par,
        ps.reorder_point as reorderPoint,
        ps.order_by_the as orderByThe
      FROM products_by_store ps
      INNER JOIN products p ON ps.id_product = p.id_products
      LEFT JOIN categories c ON p.id_category = c.id_categories
      WHERE ps.id_store = ?
      ORDER BY p.product_name
    `;
    const [rows] = await pool.execute(query, [storeId]);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error al obtener productos de la tienda:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los productos de la tienda', error: error.message });
  }
};

// ========================================
// ASIGNAR UN PRODUCTO A UNA TIENDA
// ========================================
const assignProductToStore = async (req, res) => {
  try {
    const { productId, storeId, par, reorderPoint, orderByThe } = req.body;

    if (!productId) return res.status(400).json({ success: false, message: 'El producto es requerido' });
    if (!storeId)   return res.status(400).json({ success: false, message: 'La tienda es requerida' });

    const [product] = await pool.execute('SELECT id_products FROM products WHERE id_products = ?', [productId]);
    if (product.length === 0) return res.status(404).json({ success: false, message: 'El producto no existe' });

    const [store] = await pool.execute('SELECT id_stores FROM stores WHERE id_stores = ?', [storeId]);
    if (store.length === 0) return res.status(404).json({ success: false, message: 'La tienda no existe' });

    const [existing] = await pool.execute(
      'SELECT id_product_store FROM products_by_store WHERE id_product = ? AND id_store = ?',
      [productId, storeId]
    );
    if (existing.length > 0) return res.status(409).json({ success: false, message: 'Este producto ya está asignado a esta tienda' });

    const [result] = await pool.execute(
      'INSERT INTO products_by_store (id_product, id_store, par, reorder_point, order_by_the) VALUES (?, ?, ?, ?, ?)',
      [productId, storeId, par || null, reorderPoint || null, orderByThe || null]
    );

    res.status(201).json({ success: true, message: 'Producto asignado a la tienda exitosamente', data: { id: result.insertId, productId, storeId, par, reorderPoint, orderByThe } });
  } catch (error) {
    console.error('Error al asignar producto a tienda:', error);
    res.status(500).json({ success: false, message: 'Error al asignar el producto a la tienda', error: error.message });
  }
};

// ========================================
// ACTUALIZAR UN PRODUCTO EN TIENDA
// ========================================
const updateProductInStore = async (req, res) => {
  try {
    const { id } = req.params;
    const { par, reorderPoint, orderByThe } = req.body;

    const [result] = await pool.execute(
      'UPDATE products_by_store SET par = ?, reorder_point = ?, order_by_the = ? WHERE id_product_store = ?',
      [par || null, reorderPoint || null, orderByThe || null, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Relación no encontrada' });

    res.json({ success: true, message: 'Producto actualizado en la tienda exitosamente' });
  } catch (error) {
    console.error('Error al actualizar producto en tienda:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el producto en la tienda', error: error.message });
  }
};

// ========================================
// ELIMINAR UN PRODUCTO DE UNA TIENDA
// ========================================
const removeProductFromStore = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.execute('DELETE FROM products_by_store WHERE id_product_store = ?', [id]);

    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Relación no encontrada' });

    res.json({ success: true, message: 'Producto removido de la tienda exitosamente' });
  } catch (error) {
    console.error('Error al remover producto de tienda:', error);
    res.status(500).json({ success: false, message: 'Error al remover el producto de la tienda', error: error.message });
  }
};

// ========================================
// IMPORTAR PRODUCTOS POR TIENDA DESDE EXCEL
// Columnas: Product Name, Product Code, Par, Reorder Point, Order By
// - Verifica que el producto exista en el sistema
// - Si ya está asignado a la tienda → actualiza Par, Reorder Point, Order By
// - Si no está asignado → lo asigna
// ========================================
const importProductsByStore = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const { storeId } = req.body;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    // Verificar que exista la tienda
    const [store] = await pool.execute('SELECT id_stores FROM stores WHERE id_stores = ?', [storeId]);
    if (store.length === 0) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    // Leer Excel
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null });

    let imported = 0;
    let updated  = 0;
    let skipped  = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2;

      const productName = row['Product Name'] ? String(row['Product Name']).trim() : null;
      const productCode = row['Product Code'] ? String(row['Product Code']).trim() : null;

      // Saltar filas vacías
      if (!productName && !productCode) {
        skipped++;
        continue;
      }

      try {
        // Buscar el producto en el sistema — primero por nombre, luego por código
        let productRow = null;

        if (productName) {
          const [byName] = await pool.execute(
            'SELECT id_products FROM products WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))',
            [productName]
          );
          if (byName.length > 0) productRow = byName[0];
        }

        if (!productRow && productCode) {
          const [byCode] = await pool.execute(
            'SELECT id_products FROM products WHERE LOWER(TRIM(product_code)) = LOWER(TRIM(?))',
            [productCode]
          );
          if (byCode.length > 0) productRow = byCode[0];
        }

        // El producto no existe en el sistema — saltar con error
        if (!productRow) {
          errors.push(`Row ${rowNum}: Product "${productName || productCode}" not found in the system`);
          skipped++;
          continue;
        }

        const productId = productRow.id_products;
        const par         = row['Par']           ? parseFloat(row['Par'])           : null;
        const reorderPoint = row['Reorder Point'] ? parseFloat(row['Reorder Point']) : null;
        const orderByThe  = row['Order By']       ? String(row['Order By']).trim()   : null;

        // Verificar si ya está asignado a esta tienda
        const [existing] = await pool.execute(
          'SELECT id_product_store FROM products_by_store WHERE id_product = ? AND id_store = ?',
          [productId, storeId]
        );

        if (existing.length > 0) {
          // Ya existe → actualizar Par, Reorder Point, Order By
          await pool.execute(
            'UPDATE products_by_store SET par = ?, reorder_point = ?, order_by_the = ? WHERE id_product_store = ?',
            [par, reorderPoint, orderByThe, existing[0].id_product_store]
          );
          updated++;
        } else {
          // No existe → asignar a la tienda
          await pool.execute(
            'INSERT INTO products_by_store (id_product, id_store, par, reorder_point, order_by_the) VALUES (?, ?, ?, ?, ?)',
            [productId, storeId, par, reorderPoint, orderByThe]
          );
          imported++;
        }
      } catch (rowError) {
        console.error(`Error processing row ${rowNum}:`, rowError);
        errors.push(`Row ${rowNum}: ${rowError.message}`);
        skipped++;
      }
    }

    res.json({
      success: true,
      message: 'Import completed',
      stats: {
        total:    data.length,
        imported,
        updated,
        skipped,
        errors:   errors.length > 0 ? errors : undefined
      }
    });

  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ success: false, message: 'Error importing products by store', error: error.message });
  }
};

module.exports = {
  getAllProductsByStore,
  getProductsByStoreId,
  assignProductToStore,
  updateProductInStore,
  removeProductFromStore,
  importProductsByStore
};