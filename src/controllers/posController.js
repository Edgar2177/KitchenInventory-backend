const pool = require('../config/database');
const Papa = require('papaparse');

// ── HELPERS (mismos que modifiers) ────────────────────────────────────────

const parseDate = (val) => {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
};

// Soporta 0 correctamente — no usa || null
const parseDecimal = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
};

const str = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
};

const bigint = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  return s === '' ? null : s;
};

const parseBool = (val) => {
  if (val === true  || val === 1 || String(val).toLowerCase() === 'true')  return 1;
  if (val === false || val === 0 || String(val).toLowerCase() === 'false') return 0;
  return 0;
};

// ── CONTROLLERS ──────────────────────────────────────────────────────────

const getAllPOSData = async (req, res) => {
  try {
    const { storeId } = req.query;
    const query = `
      SELECT 
        id_pos_raw            as id,
        id_store              as storeId,
        location,
        order_id              as orderId,
        order_number          as orderNumber,
        sent_date             as sentDate,
        order_date            as orderDate,
        check_id              as checkId,
        server,
        table_number          as tableNumber,
        dining_area           as diningArea,
        service,
        dining_option         as diningOption,
        item_selection_id     as itemSelectionId,
        item_id               as itemId,
        master_id             as masterId,
        sku,
        plu,
        menu_item             as menuItem,
        menu_subgroups        as menuSubgroups,
        menu_group            as menuGroup,
        menu,
        sales_category        as salesCategory,
        gross_price           as grossPrice,
        discount,
        net_price             as netPrice,
        qty,
        tax,
        is_void               as isVoid,
        is_deferred           as isDeferred,
        is_tax_exempt         as isTaxExempt,
        tax_inclusion_option  as taxInclusionOption,
        dining_option_tax     as diningOptionTax,
        tab_name              as tabName,
        import_date           as importDate,
        file_name             as fileName
      FROM pos_raw_data
      ${storeId ? 'WHERE id_store = ?' : ''}
      ORDER BY order_date DESC, order_id DESC
    `;

    const params = storeId ? [storeId] : [];
    const [rows] = await pool.execute(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching POS data:', error);
    res.status(500).json({ success: false, message: 'Error fetching POS data', error: error.message });
  }
};

const importPOSData = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const { storeId } = req.body;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'Store ID is required' });
    }

    const csvString = req.file.buffer.toString('utf-8');

    Papa.parse(csvString, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false, // ← OFF: manejamos tipos manualmente para soportar 0
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
                `INSERT INTO pos_raw_data (
                  id_store, location, order_id, order_number, sent_date, order_date,
                  check_id, server, table_number, dining_area, service, dining_option,
                  item_selection_id, item_id, master_id, sku, plu, menu_item,
                  menu_subgroups, menu_group, menu, sales_category, gross_price,
                  discount, net_price, qty, tax, is_void, is_deferred, is_tax_exempt,
                  tax_inclusion_option, dining_option_tax, tab_name, file_name
                ) VALUES (
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?
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
                  bigint(row['Item Id']),
                  bigint(row['Master Id']),
                  str(row['SKU']),
                  str(row['PLU']),
                  str(row['Menu Item']),
                  str(row['Menu Subgroup(s)']),
                  str(row['Menu Group']),
                  str(row['Menu']),
                  str(row['Sales Category']),
                  parseDecimal(row['Gross Price']),  // ✅ soporta 0.00
                  parseDecimal(row['Discount']),      // ✅ soporta 0.00
                  parseDecimal(row['Net Price']),     // ✅ soporta 0.00
                  parseDecimal(row['Qty']),           // ✅ soporta 0
                  parseDecimal(row['Tax']),           // ✅ soporta 0.00
                  parseBool(row['Void?']),
                  parseBool(row['Deferred']),
                  parseBool(row['Tax Exempt']),
                  str(row['Tax Inclusion Option']),
                  str(row['Dining Option Tax']),
                  str(row['Tab Name']),
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
              total: data.length,
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
    console.error('Error importing POS data:', error);
    res.status(500).json({ success: false, message: 'Error importing POS data', error: error.message });
  }
};

const deletePOSRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute(
      'DELETE FROM pos_raw_data WHERE id_pos_raw = ?', [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    res.json({ success: true, message: 'Record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting record', error: error.message });
  }
};

const clearStoreData = async (req, res) => {
  try {
    const { storeId } = req.params;
    const [result] = await pool.execute(
      'DELETE FROM pos_raw_data WHERE id_store = ?', [storeId]
    );
    res.json({
      success: true,
      message: `${result.affectedRows} records deleted`,
      deletedCount: result.affectedRows
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error clearing data', error: error.message });
  }
};

module.exports = {
  getAllPOSData,
  importPOSData,
  deletePOSRecord,
  clearStoreData
};