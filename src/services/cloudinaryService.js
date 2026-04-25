const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// Configurar Cloudinary con variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================================
// Subir imagen desde buffer (multer en memoria)
// ============================================================
const uploadReceiptImage = (buffer, filename) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder:          'invoices/receipts',
        public_id:       filename,
        resource_type:   'image',
        transformation: [
          { quality: 'auto:good' },  // compresión automática
          { fetch_format: 'auto' }   // formato óptimo (webp si el browser lo soporta)
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    // Convertir buffer a stream y subir
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
};

// ============================================================
// Eliminar imagen de Cloudinary (por public_id)
// ============================================================
const deleteReceiptImage = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error('Error deleting image from Cloudinary:', error);
    return null;
  }
};

module.exports = { uploadReceiptImage, deleteReceiptImage };