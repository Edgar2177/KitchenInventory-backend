const pool = require('../config/database');
const Papa = require('papaparse');

// ── HELPERS ───────────────────────────────────────────────────────────────

// Parsea fechas del formato "5/6/26 1:03 PM" o ISO — devuelve null si inválido
const parseDate = (val) => {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
};

// Convierte a decimal o null — soporta 0 correctamente
const parseDecimal = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
};

// Convierte a string o null — ignora vacíos
const str = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
};

// Convierte a BIGINT string o null
const bigint = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  return s === '' ? null : s;
};

// Convierte bool/string a 0/1
const parseBool = (val) => {
  if (val === true  || val === 1 || String(val).toLowerCase() === 'true')  return 1;
  if (val === false || val === 0 || String(val).toLowerCase() === 'false') return 0;
  return 0;
};

// ── CONTROLLERS ──────────────────────────────────────────────────────────

// GET /modifiers?storeId=X
const getAllModifiers = async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    const [rows] = await pool.execute(
      `SELECT
        id_modifier       as id,
        id_store          as storeId,
        location,
        order_id          as orderId,
        order_number      as orderNumber,
        sent_date         as sentDate,
        order_date        as orderDate,
        check_id          as checkId,
        server,
        table_number      as tableNumber,
        dining_area       as diningArea,
        service,
        dining_option     as diningOption,
        item_selection_id as itemSelectionId,
        modifier_id       as modifierId,
        master_id         as masterId,
        modifier_sku      as modifierSku,
        modifier_plu      as modifierPlu,
        modifier,
        option_group_id   as optionGroupId,
        option_group_name as optionGroupName,
        parent_item_id    as parentItemId,
        parent_item_name  as parentItemName,
        sales_category    as salesCategory,
        gross_price       as grossPrice,
        discount,
        net_price         as netPrice,
        qty,
        is_void           as isVoid,
        void_reason_id    as voidReasonId,
        void_reason       as voidReason,
        file_name         as fileName,
        import_date       as importDate
      FROM modifiers
      WHERE id_store = ?
      ORDER BY order_date DESC, order_id DESC`,
      [storeId]
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (error) {
    console.error('Error fetching modifiers:', error);
    res.status(500).json({ success: false, message: 'Error fetching modifiers', error: error.message });
  }
};

// POST /modifiers/import  (multipart: file + storeId)
const importModifiers = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const { storeId } = req.body;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }

    const csvString = req.file.buffer.toString('utf-8');

    Papa.parse(csvString, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false, // dejamos strings para parsear manualmente y soportar 0
      complete: async (results) => {
        try {
          const data = results.data;
          let imported = 0;
          let skipped  = 0;
          const errors = [];

          for (let i = 0; i < data.length; i++) {
            const row = data[i];
            try {
              await pool.execute(
                `INSERT INTO modifiers (
                  id_store, location, order_id, order_number,
                  sent_date, order_date, check_id, server,
                  table_number, dining_area, service, dining_option,
                  item_selection_id, modifier_id, master_id,
                  modifier_sku, modifier_plu, modifier,
                  option_group_id, option_group_name,
                  parent_item_id, parent_item_name,
                  sales_category, gross_price, discount, net_price,
                  qty, is_void, void_reason_id, void_reason, file_name
                ) VALUES (
                  ?, ?, ?, ?,
                  ?, ?, ?, ?,
                  ?, ?, ?, ?,
                  ?, ?, ?,
                  ?, ?, ?,
                  ?, ?,
                  ?, ?,
                  ?, ?, ?, ?,
                  ?, ?, ?, ?, ?
                )`,
                [
                  storeId,
                  str(row['Location']),
                  bigint(row['Order Id']),
                  str(row['Order #']),
                  parseDate(row['Sent Date']),
                  parseDate(row['Order Date']),
                  bigint(row['Check Id']),
                  str(row['Server']),
                  str(row['Table']),
                  str(row['Dining Area']),
                  str(row['Service']),
                  str(row['Dining Option']),
                  bigint(row['Item Selection Id']),
                  bigint(row['Modifier Id']),
                  bigint(row['Master Id']),
                  str(row['Modifier SKU']),
                  str(row['Modifier PLU']),
                  str(row['Modifier']),
                  bigint(row['Option Group ID']),
                  str(row['Option Group Name']),
                  bigint(row['Parent Menu Selection Item ID']),
                  str(row['Parent Menu Selection']),
                  str(row['Sales Category']),
                  parseDecimal(row['Gross Price']),   // soporta 0.00
                  parseDecimal(row['Discount']),       // soporta 0.00
                  parseDecimal(row['Net Price']),      // soporta 0.00
                  parseDecimal(row['Qty']),            // soporta 0
                  parseBool(row['Void?']),
                  str(row['Void Reason ID']),
                  str(row['Void Reason']),
                  str(req.file.originalname)
                ]
              );
              imported++;
            } catch (rowError) {
              skipped++;
              errors.push(`Row ${i + 2}: ${rowError.message}`);
            }
          }

          res.json({
            success: true,
            message: 'Import completed',
            stats: {
              total:    data.length,
              imported,
              skipped,
              errors: errors.length > 0 ? errors : null
            }
          });
        } catch (error) {
          console.error('Error processing CSV:', error);
          res.status(500).json({ success: false, message: 'Error processing CSV', error: error.message });
        }
      },
      error: (error) => {
        res.status(500).json({ success: false, message: 'Error parsing CSV', error: error.message });
      }
    });
  } catch (error) {
    console.error('Error importing modifiers:', error);
    res.status(500).json({ success: false, message: 'Error importing modifiers', error: error.message });
  }
};

// DELETE /modifiers/:id
const deleteModifier = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute(
      'DELETE FROM modifiers WHERE id_modifier = ?', [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Modifier not found' });
    }
    res.json({ success: true, message: 'Modifier deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting modifier', error: error.message });
  }
};

// DELETE /modifiers/store/:storeId  — limpia todos los de una tienda
const clearStoreModifiers = async (req, res) => {
  try {
    const { storeId } = req.params;
    const [result] = await pool.execute(
      'DELETE FROM modifiers WHERE id_store = ?', [storeId]
    );
    res.json({
      success: true,
      message: `${result.affectedRows} modifiers deleted`,
      deletedCount: result.affectedRows
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error clearing modifiers', error: error.message });
  }
};

module.exports = {
  getAllModifiers,
  importModifiers,
  deleteModifier,
  clearStoreModifiers
};