const pool = require('../config/database');
const bcrypt = require('bcryptjs');

const VALID_ROLES = ['admin', 'employee', 'kitchen'];   // ← AGREGADO 'kitchen'

// Obtener todos los usuarios con sus tiendas
const getAllUsers = async (req, res) => {
  try {
    const [users] = await pool.execute(
      `SELECT 
        id_users as id, 
        name, 
        email, 
        role, 
        created_at as createdAt,
        updated_at as updatedAt
      FROM users 
      ORDER BY name`,
      []
    );

    for (let user of users) {
      const [stores] = await pool.execute(
        `SELECT 
          s.id_stores as id,
          s.store_name as name
        FROM user_stores us
        INNER JOIN stores s ON us.id_store = s.id_stores
        WHERE us.id_user = ?
        ORDER BY s.store_name`,
        [user.id]
      );
      user.stores = stores;
    }

    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ success: false, message: 'Error getting users', error: error.message });
  }
};

// Obtener un usuario por ID con sus tiendas
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const [users] = await pool.execute(
      `SELECT 
        id_users as id, 
        name, 
        email, 
        role, 
        created_at as createdAt,
        updated_at as updatedAt
      FROM users 
      WHERE id_users = ?`,
      [id]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = users[0];

    const [stores] = await pool.execute(
      `SELECT 
        s.id_stores as id,
        s.store_name as name
      FROM user_stores us
      INNER JOIN stores s ON us.id_store = s.id_stores
      WHERE us.id_user = ?
      ORDER BY s.store_name`,
      [id]
    );
    user.stores = stores;

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({ success: false, message: 'Error getting user', error: error.message });
  }
};

// Crear un nuevo usuario
const createUser = async (req, res) => {
  try {
    const { name, email, password, role, storeIds } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!email || email.trim() === '') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    if (!password || password.trim() === '') {
      return res.status(400).json({ success: false, message: 'Password is required' });
    }
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Valid role is required (${VALID_ROLES.join(', ')})`
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    const [existingUsers] = await pool.execute(
      'SELECT id_users FROM users WHERE email = ?',
      [email.trim().toLowerCase()]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name.trim(), email.trim().toLowerCase(), hashedPassword, role]
    );

    const userId = result.insertId;

    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      const storeValues = storeIds.map(storeId => [userId, storeId]);
      await pool.query('INSERT INTO user_stores (id_user, id_store) VALUES ?', [storeValues]);
    }

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: { id: userId, name: name.trim(), email: email.trim().toLowerCase(), role }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ success: false, message: 'Error creating user', error: error.message });
  }
};

// Actualizar un usuario
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, storeIds } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!email || email.trim() === '') {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Valid role is required (${VALID_ROLES.join(', ')})`
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    const [existingUsers] = await pool.execute(
      'SELECT id_users FROM users WHERE email = ? AND id_users != ?',
      [email.trim().toLowerCase(), id]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.execute(
        'UPDATE users SET name = ?, email = ?, password = ?, role = ? WHERE id_users = ?',
        [name.trim(), email.trim().toLowerCase(), hashedPassword, role, id]
      );
    } else {
      await pool.execute(
        'UPDATE users SET name = ?, email = ?, role = ? WHERE id_users = ?',
        [name.trim(), email.trim().toLowerCase(), role, id]
      );
    }

    await pool.execute('DELETE FROM user_stores WHERE id_user = ?', [id]);

    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      const storeValues = storeIds.map(storeId => [id, storeId]);
      await pool.query('INSERT INTO user_stores (id_user, id_store) VALUES ?', [storeValues]);
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      data: { id: parseInt(id), name: name.trim(), email: email.trim().toLowerCase(), role }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ success: false, message: 'Error updating user', error: error.message });
  }
};

const getUserStores = async (req, res) => {
  try {
    const { userId } = req.params;
    const [stores] = await pool.execute(
      `SELECT s.id_stores as id, s.store_name as name, s.address, s.created_at
       FROM user_stores us
       INNER JOIN stores s ON us.id_store = s.id_stores
       WHERE us.id_user = ?
       ORDER BY s.store_name`,
      [userId]
    );
    res.json({ success: true, data: stores });
  } catch (error) {
    console.error('Error fetching user stores:', error);
    res.status(500).json({ success: false, message: 'Error loading user stores' });
  }
};

// Eliminar un usuario
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id) === 1) {
      return res.status(403).json({ success: false, message: 'Cannot delete the main administrator account' });
    }

    const [result] = await pool.execute('DELETE FROM users WHERE id_users = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ success: false, message: 'Error deleting user', error: error.message });
  }
};

module.exports = {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserStores
};