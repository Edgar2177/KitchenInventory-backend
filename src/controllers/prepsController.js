//Conexión de la DB
const pool = require('../config/database');

//Obtener los preparados de la tienda
const getAllPreps = async (req, res) => {
    try{
        const { storeId } = req.query;

        if(!storeId){
            return res.status(400).json({
                success:false,
                message: 'Store ID is required'
            });
        }

        const [preps] = await pool.execute(`
            SELECT
                p.id_preps as id,
                p.prep_name as name,
                p.total_cost as totalCost,
                p.yield_quantity as yieldQuantity,
                p.yield_unit as yieldUnit,
                p.yield_unit_cost as yieldUnitCost,
                p.created_at as createdAt,
                COUNT(pi.id_prep_ingredient) as ingredientCount
            FROM preps p
            LEFT JOIN prep_ingredients pi ON p.id_preps = pi.id_prep
            WHERE p.id_store = ?
            GROUP BY p.id_preps
            ORDER BY p.prep_name`, [storeId]
        );

        res.json({
            success: true,
            data: preps
        });
    }catch(error){
        console.error('Error fetching preparations:', error);
        res.status(500).json({
            success:false,
            message:'Error fetching preparations',
            error: error.message
        });
    }
};

//Obtener la preparación por ID con sus ingredientes
const getPrepById = async (req, res) => {
    try{
        const {id} = req.params;

        const [preps] = await pool.execute(`
            SELECT 
                id_preps as id,
                id_store as storeId,
                prep_name as name,
                total_cost as totalCost,
                yield_quantity as yieldQuantity,
                yield_unit as yieldUnit,
                yield_unit_cost as yieldUnitCost,
                created_at as createdAt
            FROM preps
            WHERE id_preps = ?`, [id]
        );

        if(preps.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Preparation not found'
            });
        }

        //Obtener ingredientes
        const [ingredients] = await pool.execute(`
            SELECT
                pi.id_prep_ingredient as id,
                pi.id_product as productId,
                p.product_name as productName,
                pi.quantity,
                pi.unit,
                pi.unit_cost as unitCost,
                pi.total_cost as totalCost
            FROM prep_ingredients pi
            INNER JOIN products p ON pi.id_product = p.id_products
            WHERE pi.id_prep = ?
            ORDER BY p.product_name`, [id]
        );
        
        const prep = {
            ...preps[0],
            ingredients
        };

        res.json({
            success:true,
            data: prep
        });
    }catch(error){
        console.error('Error fetching preparation:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching preparation',
            error: error.message
        });
    }
};

//Crear preparaciones
const createPrep = async (req, res) => {
    const connection = await pool.getConnection();
    try{
        await connection.beginTransaction();

        const {storeId, name, ingredients, yieldQuantity, yieldUnit} = req.body;

        //Validaciones
        if(!storeId) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Store ID is required'
            });
        }
        
        if(!name || !name.trim()){
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Preparation name is required'
            })
        }

        if(!ingredients || ingredients.length === 0){
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'At least one ingredient is required'
            });
        }

        //Verificar nombre único en la tienda
        const [existing] = await connection.execute(
            'SELECT id_preps FROM preps WHERE LOWER(TRIM(prep_name)) = LOWER(TRIM(?)) AND id_store = ?'
            , [name, storeId]
        );

        if(existing.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                success: false,
                message: 'A preparation with that name already exists in this store'
            });
        }

        //Calcular el costo total
        let totalCost = 0;
        ingredients.forEach(ing => {
            totalCost += parseFloat(ing.totalCost);
        });

        // Calcular yield_unit_cost
        const yieldUnitCost = yieldQuantity && parseFloat(yieldQuantity) > 0
          ? totalCost / parseFloat(yieldQuantity)
          : null;

        //Insertar preparación
        const [result] = await connection.execute(`
          INSERT INTO preps (id_store, prep_name, total_cost, yield_quantity, yield_unit, yield_unit_cost)
          VALUES (?, ?, ?, ?, ?, ?)`,
          [storeId, name.trim(), totalCost, yieldQuantity ? parseFloat(yieldQuantity) : null, yieldUnit || null, yieldUnitCost]
        );
        
        const prepId = result.insertId;

        //Insertar ingredientes
        for(const ingredient of ingredients){
            await connection.execute(
                `INSERT INTO prep_ingredients
                (id_prep, id_product, quantity, unit, unit_cost, total_cost) 
                VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    prepId, 
                    ingredient.productId, 
                    ingredient.quantity, 
                    ingredient.unit, 
                    ingredient.unitCost, 
                    ingredient.totalCost
                ]
            );
        }
        

        await connection.commit();

        res.status(201).json({
            success:true,
            message: 'Preparation created successfully',
            data: {id: prepId}
        });
    }catch(error){
        await connection.rollback();
        console.error('Error creating preparation:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating preparation',
            error: error.message
        });
    }finally{
        connection.release();
    }
};

//Actualizar el preparado
const updatePrep = async (req, res) => {
    const connection = await pool.getConnection();
    try{
        await connection.beginTransaction();
        const {id} = req.params;
        const {name, ingredients, yieldQuantity, yieldUnit} = req.body;
        
        if(!name || !name.trim()){
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Preparation name is required'
            });
        }
        
        if(!ingredients || ingredients.length === 0){
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'At least one ingredient is required'
            });
        }

        //Verificar que existe
        const [existing] = await connection.execute(
            'SELECT id_store FROM preps WHERE id_preps = ?', 
            [id]
        );

        if(existing.length === 0){
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Preparation not found'
            });
        }

        const storeId = existing[0].id_store;

        //Verificar nombre único 
        const [duplicate] = await connection.execute(
            'SELECT id_preps FROM preps WHERE LOWER(TRIM(prep_name)) = LOWER(TRIM(?)) AND id_store = ? AND id_preps != ?',
            [name, storeId, id]
        );

        if(duplicate.length > 0){
            await connection.rollback();
            return res.status(409).json({
                success: false,
                message: 'A preparation with that name already exists in this store'
            });
        }

        //Calcular costo
        let totalCost = 0;
        ingredients.forEach(ing => {
            totalCost += parseFloat(ing.totalCost);
        });

        const yieldUnitCost = yieldQuantity && parseFloat(yieldQuantity) > 0
        ? totalCost / parseFloat(yieldQuantity)
        : null;

        //Actualizar preparación
        await connection.execute(`
            UPDATE preps 
            SET prep_name = ?, total_cost = ?, yield_quantity = ?, yield_unit = ?, 
            yield_unit_cost = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id_preps = ?`,
            [name.trim(), totalCost, yieldQuantity ? parseFloat(yieldQuantity) : null, yieldUnit || null, yieldUnitCost, id]
        );

        //Eliminar ingredientes existentes
        await connection.execute(
            'DELETE FROM prep_ingredients WHERE id_prep = ?',
            [id]
        );

        //Insertar nuevos ingredientes
        for(const ingredient of ingredients){
            await connection.execute(`
                INSERT INTO prep_ingredients
                (id_prep, id_product, quantity, unit, unit_cost, total_cost) 
                VALUES (?, ?, ?, ?, ?, ?)`,
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

        await connection.commit();

        res.json({
            success: true,
            message: 'Preparation updated successfully'
        });
    }catch(error){
        await connection.rollback();
        console.error('Error updating preparation:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating preparation',
            error: error.message
        });
    }finally{
        connection.release();
    }
};

//Eliminar preparado
const deletePrep = async (req, res) => {
    try{
        const {id} = req.params;

        const [result] = await pool.execute(
            'DELETE FROM preps WHERE id_preps = ?', 
            [id]
        );

        if(result.affectedRows === 0){
            return res.status(404).json({
                success: false,
                message: 'Preparation not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Preparation deleted successfully'
        });
    }catch(error){
        console.error('Error deleting preparation:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting preparation',
            error: error.message
        });
    }
};

module.exports = {
    getAllPreps,
    getPrepById,
    createPrep,
    updatePrep,
    deletePrep
};