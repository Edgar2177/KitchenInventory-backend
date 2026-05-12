const pool = require('../config/database'); 
const { convertToBaseUnit } = require('../utils/unitConversions');

const getBaseUnitLabel = (unit) => {
  const volumeUnits = ['ml', 'L', 'Gallon', 'fl oz'];
  const weightUnits = ['g', 'kg', 'lb', 'oz'];
  const countUnits  = ['Each', 'Bottle', 'Keg', 'Can', 'Box', 'Bag', 'Carton'];
  if (volumeUnits.includes(unit)) return 'ml';
  if (weightUnits.includes(unit)) return 'g';
  if (countUnits.includes(unit))  return 'unit';
  return '';
};

const normalizeName = (name) => name.trim().toLowerCase();

const checkDuplicateName = async (name, excludeId = null) => {
  const normalizedName = normalizeName(name);
  let query  = 'SELECT id_products FROM products WHERE LOWER(TRIM(product_name)) = ?';
  let params = [normalizedName];
  if (excludeId) { query += ' AND id_products != ?'; params.push(excludeId); }
  const [rows] = await pool.execute(query, params);
  return rows.length > 0;
};

// ============================================================
// HELPER: calcula base_unit manejando correctamente el valor 0
// ============================================================
const safeConvertToBaseUnit = (value, unit) => {
  // ← FIX: verifica explícitamente en vez de usar truthiness
  // Esto evita que empty_weight = 0 sea tratado como "sin valor"
  if (value !== null && value !== undefined && value !== '' && unit) {
    return convertToBaseUnit(parseFloat(value), unit);
  }
  return null;
};

// ============================================================
// GET ALL PRODUCTS
// ============================================================
const getAllProducts = async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id_products as id,
        p.product_name as name,
        p.product_code as productCode,
        p.id_product_type as productTypeId,
        pt.product_name as productTypeName,
        p.id_category as categoryId,
        c.category_name as categoryName,
        p.container_type as containerType,
        p.container_size as containerSize,
        p.container_unit as containerUnit,
        p.container_size_base_unit as containerSizeBaseUnit,
        p.wholesale_price as wholesalePrice,
        p.single_portion_size as singlePortionSize,
        p.single_portion_unit as singlePortionUnit,
        p.single_portion_base_unit as singlePortionBaseUnit,
        p.full_weight as fullWeight,
        p.full_weight_unit as fullWeightUnit,
        p.full_weight_base_unit as fullWeightBaseUnit,
        p.empty_weight as emptyWeight,
        p.empty_weight_unit as emptyWeightUnit,
        p.empty_weight_base_unit as emptyWeightBaseUnit,
        p.case_size as caseSize,
        p.id_vendor as vendorId,
        v.vendor_name as vendorName,
        p.created_at as createdAt,
        p.updated_at as updatedAt
      FROM products p
      INNER JOIN product_types pt ON p.id_product_type = pt.id_product_types
      INNER JOIN categories c ON p.id_category = c.id_categories
      LEFT JOIN vendors v ON p.id_vendor = v.id_vendors
      ORDER BY p.product_name
    `;
    const [rows] = await pool.execute(query, []);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los productos', error: error.message });
  }
};

// ============================================================
// GET PRODUCT BY ID
// ============================================================
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        p.id_products as id,
        p.product_name as name,
        p.product_code as productCode,
        p.id_product_type as productTypeId,
        pt.product_name as productTypeName,
        p.id_category as categoryId,
        c.category_name as categoryName,
        p.container_type as containerType,
        p.container_size as containerSize,
        p.container_unit as containerUnit,
        p.container_size_base_unit as containerSizeBaseUnit,
        p.wholesale_price as wholesalePrice,
        p.single_portion_size as singlePortionSize,
        p.single_portion_unit as singlePortionUnit,
        p.single_portion_base_unit as singlePortionBaseUnit,
        p.full_weight as fullWeight,
        p.full_weight_unit as fullWeightUnit,
        p.full_weight_base_unit as fullWeightBaseUnit,
        p.empty_weight as emptyWeight,
        p.empty_weight_unit as emptyWeightUnit,
        p.empty_weight_base_unit as emptyWeightBaseUnit,
        p.case_size as caseSize,
        p.id_vendor as vendorId,
        v.vendor_name as vendorName,
        p.created_at as createdAt,
        p.updated_at as updatedAt
      FROM products p
      INNER JOIN product_types pt ON p.id_product_type = pt.id_product_types
      INNER JOIN categories c ON p.id_category = c.id_categories
      LEFT JOIN vendors v ON p.id_vendor = v.id_vendors
      WHERE p.id_products = ?
    `;
    const [rows] = await pool.execute(query, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Error al obtener producto:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el producto', error: error.message });
  }
};

// ============================================================
// CREATE PRODUCT
// ============================================================
const createProduct = async (req, res) => {
  try {
    const {
      name, productCode, productTypeId, categoryId,
      containerType, containerSize, containerUnit,
      wholesalePrice, singlePortionSize, singlePortionUnit,
      fullWeight, fullWeightUnit, emptyWeight, emptyWeightUnit,
      caseSize, vendorId
    } = req.body;

    // Validaciones
    if (!name || name.trim() === '') return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    if (!productTypeId)  return res.status(400).json({ success: false, message: 'El tipo de producto es requerido' });
    if (!categoryId)     return res.status(400).json({ success: false, message: 'La categoría es requerida' });
    if (!containerType)  return res.status(400).json({ success: false, message: 'El tipo de contenedor es requerido' });
    if (!containerSize || containerSize <= 0) return res.status(400).json({ success: false, message: 'El tamaño del contenedor es requerido' });
    if (!containerUnit)  return res.status(400).json({ success: false, message: 'La unidad del contenedor es requerida' });

    const normalizedName = name.trim();
    const isDuplicate = await checkDuplicateName(normalizedName);
    if (isDuplicate) return res.status(409).json({ success: false, message: 'Ya existe un producto con ese nombre' });

    const [productType] = await pool.execute('SELECT id_product_types FROM product_types WHERE id_product_types = ?', [productTypeId]);
    if (productType.length === 0) return res.status(404).json({ success: false, message: 'El tipo de producto no existe' });

    const [category] = await pool.execute('SELECT id_categories FROM categories WHERE id_categories = ?', [categoryId]);
    if (category.length === 0) return res.status(404).json({ success: false, message: 'La categoría no existe' });

    if (vendorId) {
      const [vendor] = await pool.execute('SELECT id_vendors FROM vendors WHERE id_vendors = ?', [vendorId]);
      if (vendor.length === 0) return res.status(404).json({ success: false, message: 'El proveedor no existe' });
    }

    const containerSizeBaseUnit     = convertToBaseUnit(containerSize, containerUnit);
    const containerSizeBaseUnitType = getBaseUnitLabel(containerUnit);

    const singlePortionBaseUnit     = safeConvertToBaseUnit(singlePortionSize, singlePortionUnit);
    const singlePortionBaseUnitType = (singlePortionSize !== null && singlePortionSize !== undefined && singlePortionSize !== '' && singlePortionUnit)
      ? getBaseUnitLabel(singlePortionUnit) : null;

    const fullWeightBaseUnit     = safeConvertToBaseUnit(fullWeight, fullWeightUnit);
    const fullWeightBaseUnitType = (fullWeight !== null && fullWeight !== undefined && fullWeight !== '' && fullWeightUnit)
      ? getBaseUnitLabel(fullWeightUnit) : null;

    // ← FIX: usa safeConvertToBaseUnit para manejar empty_weight = 0
    const emptyWeightBaseUnit     = safeConvertToBaseUnit(emptyWeight, emptyWeightUnit);
    const emptyWeightBaseUnitType = (emptyWeight !== null && emptyWeight !== undefined && emptyWeight !== '' && emptyWeightUnit)
      ? getBaseUnitLabel(emptyWeightUnit) : null;

    const [result] = await pool.execute(
      `INSERT INTO products (
        product_name, product_code, id_product_type, id_category, 
        container_type, container_size, container_unit, 
        container_size_base_unit, container_size_base_unit_type,
        wholesale_price, 
        single_portion_size, single_portion_unit, 
        single_portion_base_unit, single_portion_base_unit_type,
        full_weight, full_weight_unit, 
        full_weight_base_unit, full_weight_base_unit_type,
        empty_weight, empty_weight_unit, 
        empty_weight_base_unit, empty_weight_base_unit_type,
        case_size, id_vendor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedName, productCode || null, productTypeId, categoryId,
        containerType, containerSize, containerUnit,
        containerSizeBaseUnit, containerSizeBaseUnitType,
        wholesalePrice || null,
        singlePortionSize || null, singlePortionUnit || null,
        singlePortionBaseUnit, singlePortionBaseUnitType,
        fullWeight || null, fullWeightUnit || null,
        fullWeightBaseUnit, fullWeightBaseUnitType,
        // ← emptyWeight: guarda 0 si es 0, null si es vacío
        (emptyWeight !== undefined && emptyWeight !== null && emptyWeight !== '') ? parseFloat(emptyWeight) : null,
        emptyWeightUnit || null,
        emptyWeightBaseUnit, emptyWeightBaseUnitType,
        caseSize || null, vendorId || null
      ]
    );

    res.status(201).json({ success: true, message: 'Producto creado exitosamente', data: { id: result.insertId, name: normalizedName } });
  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ success: false, message: 'Error al crear el producto', error: error.message });
  }
};

// ============================================================
// UPDATE PRODUCT
// ============================================================
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, productCode, productTypeId, categoryId,
      containerType, containerSize, containerUnit,
      wholesalePrice, singlePortionSize, singlePortionUnit,
      fullWeight, fullWeightUnit, emptyWeight, emptyWeightUnit,
      caseSize, vendorId
    } = req.body;

    // Validaciones
    if (!name || name.trim() === '') return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    if (!productTypeId)  return res.status(400).json({ success: false, message: 'El tipo de producto es requerido' });
    if (!categoryId)     return res.status(400).json({ success: false, message: 'La categoría es requerida' });
    if (!containerType)  return res.status(400).json({ success: false, message: 'El tipo de contenedor es requerido' });
    if (!containerSize || containerSize <= 0) return res.status(400).json({ success: false, message: 'El tamaño del contenedor es requerido' });
    if (!containerUnit)  return res.status(400).json({ success: false, message: 'La unidad del contenedor es requerida' });

    const normalizedName = name.trim();
    const isDuplicate = await checkDuplicateName(normalizedName, id);
    if (isDuplicate) return res.status(409).json({ success: false, message: 'Ya existe un producto con ese nombre' });

    const [productType] = await pool.execute('SELECT id_product_types FROM product_types WHERE id_product_types = ?', [productTypeId]);
    if (productType.length === 0) return res.status(404).json({ success: false, message: 'El tipo de producto no existe' });

    const [category] = await pool.execute('SELECT id_categories FROM categories WHERE id_categories = ?', [categoryId]);
    if (category.length === 0) return res.status(404).json({ success: false, message: 'La categoría no existe' });

    if (vendorId) {
      const [vendor] = await pool.execute('SELECT id_vendors FROM vendors WHERE id_vendors = ?', [vendorId]);
      if (vendor.length === 0) return res.status(404).json({ success: false, message: 'El proveedor no existe' });
    }

    const containerSizeBaseUnit     = convertToBaseUnit(containerSize, containerUnit);
    const containerSizeBaseUnitType = getBaseUnitLabel(containerUnit);

    const singlePortionBaseUnit     = safeConvertToBaseUnit(singlePortionSize, singlePortionUnit);
    const singlePortionBaseUnitType = (singlePortionSize !== null && singlePortionSize !== undefined && singlePortionSize !== '' && singlePortionUnit)
      ? getBaseUnitLabel(singlePortionUnit) : null;

    const fullWeightBaseUnit     = safeConvertToBaseUnit(fullWeight, fullWeightUnit);
    const fullWeightBaseUnitType = (fullWeight !== null && fullWeight !== undefined && fullWeight !== '' && fullWeightUnit)
      ? getBaseUnitLabel(fullWeightUnit) : null;

    // ← FIX: usa safeConvertToBaseUnit para manejar empty_weight = 0
    const emptyWeightBaseUnit     = safeConvertToBaseUnit(emptyWeight, emptyWeightUnit);
    const emptyWeightBaseUnitType = (emptyWeight !== null && emptyWeight !== undefined && emptyWeight !== '' && emptyWeightUnit)
      ? getBaseUnitLabel(emptyWeightUnit) : null;

    const [result] = await pool.execute(
      `UPDATE products SET 
        product_name = ?, product_code = ?, id_product_type = ?, id_category = ?,
        container_type = ?, container_size = ?, container_unit = ?, 
        container_size_base_unit = ?, container_size_base_unit_type = ?,
        wholesale_price = ?, 
        single_portion_size = ?, single_portion_unit = ?, 
        single_portion_base_unit = ?, single_portion_base_unit_type = ?,
        full_weight = ?, full_weight_unit = ?, 
        full_weight_base_unit = ?, full_weight_base_unit_type = ?,
        empty_weight = ?, empty_weight_unit = ?, 
        empty_weight_base_unit = ?, empty_weight_base_unit_type = ?,
        case_size = ?, id_vendor = ?
      WHERE id_products = ?`,
      [
        normalizedName, productCode || null, productTypeId, categoryId,
        containerType, containerSize, containerUnit,
        containerSizeBaseUnit, containerSizeBaseUnitType,
        wholesalePrice || null,
        singlePortionSize || null, singlePortionUnit || null,
        singlePortionBaseUnit, singlePortionBaseUnitType,
        fullWeight || null, fullWeightUnit || null,
        fullWeightBaseUnit, fullWeightBaseUnitType,
        // ← emptyWeight: guarda 0 si es 0, null si es vacío
        (emptyWeight !== undefined && emptyWeight !== null && emptyWeight !== '') ? parseFloat(emptyWeight) : null,
        emptyWeightUnit || null,
        emptyWeightBaseUnit, emptyWeightBaseUnitType,
        caseSize || null, vendorId || null,
        id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    res.json({ success: true, message: 'Producto actualizado exitosamente' });
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el producto', error: error.message });
  }
};

// ============================================================
// DELETE PRODUCT
// ============================================================
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM products WHERE id_products = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    res.json({ success: true, message: 'Producto eliminado exitosamente' });
  } catch (error) {
    console.error('Error al eliminar producto:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el producto', error: error.message });
  }
};

// ============================================================
// EXPORT PRODUCTS TO CSV
// ============================================================
const exportProductsToCSV = async (req, res) => {
  try {
    const query = `
      SELECT 
        p.product_name as 'Product Name',
        p.product_code as 'Product Code',
        pt.product_name as 'Product Type',
        c.category_name as 'Category',
        p.container_type as 'Container Type',
        p.container_size as 'Container Size',
        p.container_unit as 'Container Unit',
        p.wholesale_price as 'Wholesale Price',
        p.single_portion_size as 'Single Portion Size',
        p.single_portion_unit as 'Single Portion Unit',
        p.full_weight as 'Full Weight',
        p.full_weight_unit as 'Full Weight Unit',
        p.empty_weight as 'Empty Weight',
        p.empty_weight_unit as 'Empty Weight Unit',
        p.case_size as 'Case Size',
        v.vendor_name as 'Vendor'
      FROM products p
      INNER JOIN product_types pt ON p.id_product_type = pt.id_product_types
      INNER JOIN categories c ON p.id_category = c.id_categories
      LEFT JOIN vendors v ON p.id_vendor = v.id_vendors
      ORDER BY p.product_name
    `;
    const [rows] = await pool.execute(query, []);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No hay productos para exportar' });
    }

    const headers  = Object.keys(rows[0]);
    const csvRows  = rows.map(row =>
      headers.map(header => {
        const value = row[header];
        if (value === null || value === undefined) return '';
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      }).join(',')
    );

    const csv       = [headers.join(','), ...csvRows].join('\n');
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="products_export_${timestamp}.csv"`);
    res.write('\ufeff');
    res.end(csv);
  } catch (error) {
    console.error('Error al exportar productos:', error);
    res.status(500).json({ success: false, message: 'Error al exportar los productos', error: error.message });
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  exportProductsToCSV
};