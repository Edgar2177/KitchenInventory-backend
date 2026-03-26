const pool = require('../config/database');
const XLSX = require('xlsx');

// ============================================
// HELPERS — buscar IDs por nombre
// ============================================

const getProductTypeId = async (typeName) => {
  if (!typeName) return null;
  const [rows] = await pool.execute(
    'SELECT id_product_types FROM product_types WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))',
    [typeName]
  );
  return rows.length > 0 ? rows[0].id_product_types : null;
};

const getCategoryId = async (categoryName, productTypeId) => {
  if (!categoryName) return null;
  let query = 'SELECT id_categories FROM categories WHERE LOWER(TRIM(category_name)) = LOWER(TRIM(?))';
  let params = [categoryName];

  if (productTypeId) {
    query += ' AND id_product_types = ?';
    params.push(productTypeId);
  }

  const [rows] = await pool.execute(query, params);
  return rows.length > 0 ? rows[0].id_categories : null;
};

const getVendorId = async (vendorName) => {
  if (!vendorName) return null;
  const [rows] = await pool.execute(
    'SELECT id_vendors FROM vendors WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?))',
    [vendorName]
  );
  return rows.length > 0 ? rows[0].id_vendors : null;
};

// Helper — leer valor numérico ignorando fórmulas de Excel
const safeFloat = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const str = String(val);
  if (str.startsWith('=')) return null; // ignorar fórmulas
  const parsed = parseFloat(str);
  return isNaN(parsed) ? null : parsed;
};

const safeInt = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const parsed = parseInt(String(val));
  return isNaN(parsed) ? null : parsed;
};

// ============================================
// IMPORTAR PRODUCTOS DESDE EXCEL
// ============================================

const importProducts = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Leer el archivo Excel
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // cellFormula: false para obtener valores calculados en lugar de fórmulas
    const data = XLSX.utils.sheet_to_json(worksheet, { defval: null });

    let imported = 0;
    let skipped = 0;
    let errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];

      try {
        const productName = row['Product Name'];
        if (!productName || String(productName).trim() === '') {
          skipped++;
          continue;
        }

        // Obtener IDs de las relaciones
        const productTypeId = await getProductTypeId(row['Product Type']);
        const categoryId    = await getCategoryId(row['Category'], productTypeId);
        const vendorId      = await getVendorId(row['Vendor']);

        // Validaciones requeridas
        if (!productTypeId) {
          errors.push(`Row ${i + 2}: Product Type "${row['Product Type']}" not found`);
          skipped++;
          continue;
        }

        if (!categoryId) {
          errors.push(`Row ${i + 2}: Category "${row['Category']}" not found`);
          skipped++;
          continue;
        }

        if (!row['Container Type']) {
          errors.push(`Row ${i + 2}: Container Type is required`);
          skipped++;
          continue;
        }

        const containerSize = safeFloat(row['Container Size']);
        if (!containerSize || containerSize <= 0) {
          errors.push(`Row ${i + 2}: Valid Container Size is required`);
          skipped++;
          continue;
        }

        if (!row['Container Unit']) {
          errors.push(`Row ${i + 2}: Container Unit is required`);
          skipped++;
          continue;
        }

        // Preparar datos — nombres de columna exactos del Excel
        const productData = {
          product_name:        String(productName).trim(),
          product_code:        row['Product Code']        ? String(row['Product Code']) : null,
          id_product_type:     productTypeId,
          id_category:         categoryId,
          container_type:      row['Container Type'],
          container_size:      containerSize,
          container_unit:      row['Container Unit'],
          wholesale_price:     safeFloat(row['Wholesale Price']),
          single_portion_size: safeFloat(row['Single Portion Size']),
          single_portion_unit: row['Single Portion Unit'] || null,
          full_weight:         safeFloat(row['Full Weight']),
          full_weight_unit:    row['Full Weight Unit']    || null,
          // Empty Weight puede ser fórmula (=K2-F2), safeFloat la ignora y devuelve null
          empty_weight:        safeFloat(row['Empty Weight']),
          empty_weight_unit:   row['Empty Weight Unit']   || null,
          case_size:           safeInt(row['Case Size']),
          id_vendor:           vendorId
        };

        // Verificar si el producto ya existe
        const [existing] = await pool.execute(
          'SELECT id_products FROM products WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))',
          [productData.product_name]
        );

        if (existing.length > 0) {
          // Actualizar producto existente
          await pool.execute(
            `UPDATE products SET
              product_code        = ?,
              id_product_type     = ?,
              id_category         = ?,
              container_type      = ?,
              container_size      = ?,
              container_unit      = ?,
              wholesale_price     = ?,
              single_portion_size = ?,
              single_portion_unit = ?,
              full_weight         = ?,
              full_weight_unit    = ?,
              empty_weight        = ?,
              empty_weight_unit   = ?,
              case_size           = ?,
              id_vendor           = ?,
              updated_at          = CURRENT_TIMESTAMP
            WHERE id_products = ?`,
            [
              productData.product_code,
              productData.id_product_type,
              productData.id_category,
              productData.container_type,
              productData.container_size,
              productData.container_unit,
              productData.wholesale_price,
              productData.single_portion_size,
              productData.single_portion_unit,
              productData.full_weight,
              productData.full_weight_unit,
              productData.empty_weight,
              productData.empty_weight_unit,
              productData.case_size,
              productData.id_vendor,
              existing[0].id_products
            ]
          );
        } else {
          // Insertar nuevo producto
          await pool.execute(
            `INSERT INTO products (
              product_name, product_code, id_product_type, id_category,
              container_type, container_size, container_unit, wholesale_price,
              single_portion_size, single_portion_unit,
              full_weight, full_weight_unit,
              empty_weight, empty_weight_unit,
              case_size, id_vendor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              productData.product_name,
              productData.product_code,
              productData.id_product_type,
              productData.id_category,
              productData.container_type,
              productData.container_size,
              productData.container_unit,
              productData.wholesale_price,
              productData.single_portion_size,
              productData.single_portion_unit,
              productData.full_weight,
              productData.full_weight_unit,
              productData.empty_weight,
              productData.empty_weight_unit,
              productData.case_size,
              productData.id_vendor
            ]
          );
        }

        imported++;
      } catch (rowError) {
        console.error(`Error processing row ${i + 2}:`, rowError);
        errors.push(`Row ${i + 2}: ${rowError.message}`);
        skipped++;
      }
    }

    res.json({
      success: true,
      message: 'Import completed',
      stats: {
        total:    data.length,
        imported,
        skipped,
        errors:   errors.length > 0 ? errors : undefined
      }
    });

  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({
      success: false,
      message: 'Error importing products',
      error: error.message
    });
  }
};

module.exports = { importProducts };