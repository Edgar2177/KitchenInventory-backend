const nodemailer = require('nodemailer');

// Configurar transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === 'true', // true para 465, false para otros puertos
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Verificar configuración
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email configuration error:', error);
  } else {
    console.log('✅ Email server ready to send messages');
  }
});

/**
 * Generar HTML para el email de orden
 */
const generateOrderEmailHTML = (orderData) => {
  const { order_number, order_date, store_name, vendor_name, items, total_amount } = orderData;
  
  const itemsHTML = items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${item.product_code || '-'}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${item.product_name}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">${item.actual_order}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">${item.order_by || 'Unit'}</td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Purchase Order ${order_number}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); padding: 30px; border-radius: 8px 8px 0 0; color: white;">
          <h1 style="margin: 0; font-size: 28px;">Purchase Order</h1>
          <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.9;">#${order_number}</p>
        </div>

        <!-- Body -->
        <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          
          <!-- Order Info -->
          <div style="margin-bottom: 30px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; width: 50%;">
                  <strong style="color: #64748b; font-size: 12px; text-transform: uppercase;">From:</strong><br>
                  <span style="font-size: 16px; color: #1e293b;">${store_name}</span>
                </td>
                <td style="padding: 8px 0; width: 50%; text-align: right;">
                  <strong style="color: #64748b; font-size: 12px; text-transform: uppercase;">To:</strong><br>
                  <span style="font-size: 16px; color: #1e293b;">${vendor_name}</span>
                </td>
              </tr>
              <tr>
                <td style="padding: 8px 0;" colspan="2">
                  <strong style="color: #64748b; font-size: 12px; text-transform: uppercase;">Date:</strong><br>
                  <span style="font-size: 14px; color: #475569;">${new Date(order_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                </td>
              </tr>
            </table>
          </div>

          <!-- Items Table -->
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <thead>
              <tr style="background-color: #f8fafc;">
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Code</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Product</th>
                <th style="padding: 12px; text-align: center; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Quantity</th>
                <th style="padding: 12px; text-align: center; border-bottom: 2px solid #e2e8f0; font-size: 12px; color: #64748b; text-transform: uppercase;">Unit</th>
              </tr>
            </thead>
            <tbody style="font-size: 14px; color: #1e293b;">
              ${itemsHTML}
            </tbody>
          </table>


          <!-- Footer Note -->
          <div style="margin-top: 40px; padding: 20px; background-color: #f8fafc; border-radius: 6px; font-size: 13px; color: #64748b;">
            <p style="margin: 0;"><strong>Note:</strong> This is an automated purchase order from our Inventory System. Please confirm receipt and estimated delivery date.</p>
          </div>

        </div>

        <!-- Email Footer -->
        <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #94a3b8;">
          <p style="margin: 5px 0;">This email was sent from ${store_name}</p>
          <p style="margin: 5px 0;">Inventory Management System</p>
        </div>

      </div>
    </body>
    </html>
  `;
};

/**
 * Enviar email de orden de compra
 */
const sendOrderEmail = async (orderData) => {
  const { vendor_email, order_number, store_name } = orderData;

  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
    to: vendor_email,
    subject: `Purchase Order ${order_number} from ${store_name}`,
    html: generateOrderEmailHTML(orderData),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Email send error:', error);
    throw error;
  }
};

module.exports = {
  sendOrderEmail,
};