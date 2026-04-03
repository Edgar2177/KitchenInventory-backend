const pool = require('../config/database');

// Función auxiliar para normalizar nombres
const normalizeName = (name) => {
  return name.trim().toLowerCase();
};

// Verificar duplicados por tienda
const checkDuplicateName = async (storeId, name, excludeId = null) => {
  const normalizedName = normalizeName(name);
  let query = `
    SELECT id_locations 
    FROM locations 
    WHERE id_store = ? 
      AND LOWER(TRIM(location_name)) = ?
  `;
  const params = [storeId, normalizedName];

  if (excludeId) {
    query += ' AND id_locations != ?';
    params.push(excludeId);
  }

  const [rows] = await pool.execute(query, params);
  return rows.length > 0;
};

// Obtener todas las ubicaciones
const getAllLocations = async (req, res) => {
  try {
    const { storeId } = req.query;
    let query = `
      SELECT 
        l.id_locations AS id,
        l.location_name AS name,
        l.created_at AS createdAt,
        l.id_store AS storeId,
        s.store_name AS storeName
      FROM locations l
      INNER JOIN stores s ON l.id_store = s.id_stores
    `;
    const params = [];
    if (storeId) {
      query += ' WHERE l.id_store = ?';
      params.push(storeId);
    }
    query += ' ORDER BY l.location_name';
    const [rows] = await pool.execute(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting locations:', error);
    res.status(500).json({ success: false, message: 'Error retrieving locations', error: error.message });
  }
};

// Obtener ubicación por ID
const getLocationById = async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        l.id_locations AS id,
        l.location_name AS name,
        l.created_at AS createdAt,
        l.id_store AS storeId,
        s.store_name AS storeName
      FROM locations l
      INNER JOIN stores s ON l.id_store = s.id_stores
      WHERE l.id_locations = ?
    `;

    const [rows] = await pool.execute(query, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Error getting location:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting location',
      error: error.message
    });
  }
};

// Crear ubicación
const createLocation = async (req, res) => {
  try {
    const { storeId, name } = req.body;

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: 'The store is required'
      });
    }

    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'The name is required'
      });
    }

    const normalizedName = name.trim();

    const [store] = await pool.execute(
      'SELECT id_stores FROM stores WHERE id_stores = ?',
      [storeId]
    );

    if (store.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'The store does not exist'
      });
    }

    const isDuplicate = await checkDuplicateName(storeId, normalizedName);

    if (isDuplicate) {
      return res.status(409).json({
        success: false,
        message: 'There is already a location with that name for this store.'
      });
    }

    const [result] = await pool.execute(
      'INSERT INTO locations (id_store, location_name) VALUES (?, ?)',
      [storeId, normalizedName]
    );

    res.status(201).json({
      success: true,
      message: 'Location created successfully',
      data: {
        id: result.insertId,
        storeId,
        name: normalizedName
      }
    });
  } catch (error) {
    console.error('Error creating location:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating location',
      error: error.message
    });
  }
};

// Actualizar ubicación
const updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { storeId, name } = req.body;

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: 'The store is required'
      });
    }

    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'The name is required'
      });
    }

    const normalizedName = name.trim();

    const [store] = await pool.execute(
      'SELECT id_stores FROM stores WHERE id_stores = ?',
      [storeId]
    );

    if (store.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'The store does not exist'
      });
    }

    const isDuplicate = await checkDuplicateName(storeId, normalizedName, id);

    if (isDuplicate) {
      return res.status(409).json({
        success: false,
        message: 'There is already a location with that name for this store.'
      });
    }

    const [result] = await pool.execute(
      'UPDATE locations SET id_store = ?, location_name = ? WHERE id_locations = ?',
      [storeId, normalizedName, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }

    res.json({
      success: true,
      message: 'Location updated successfully',
      data: {
        id: parseInt(id),
        storeId,
        name: normalizedName
      }
    });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating location',
      error: error.message
    });
  }
};

// Eliminar ubicación
const deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM locations WHERE id_locations = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }

    res.json({
      success: true,
      message: 'Location successfully removed'
    });
  } catch (error) {
    console.error('Failed to delete location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete location',
      error: error.message
    });
  }
};

module.exports = {
  getAllLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation
};
