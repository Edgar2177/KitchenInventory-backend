const nodemailer = require('nodemailer');

// Configurar transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Verificar configuración
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email configuration error:', error.message);
    console.error('Config being used:', {
      host:   process.env.EMAIL_HOST     || 'NOT SET',
      port:   process.env.EMAIL_PORT     || 'NOT SET',
      secure: process.env.EMAIL_SECURE   || 'NOT SET',
      user:   process.env.EMAIL_USER     || 'NOT SET',
      pass:   process.env.EMAIL_PASSWORD ? 'SET' : 'NOT SET',
    });
  } else {
    console.log('✅ Email server ready to send messages');
  }
});

// Función auxiliar para escapar HTML
const escapeHtml = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
};

/**
 * Generar HTML para el email de orden - VERSIÓN OPTIMIZADA
 */
const generateOrderEmailHTML = (orderData) => {
  const { order_number, order_date, store_name, vendor_name, items, total_amount, total_items } = orderData;
  
  // Limitar a máximo 100 items para mostrar en el email
  const MAX_ITEMS = 100;
  const displayItems = items.slice(0, MAX_ITEMS);
  const hasMoreItems = items.length > MAX_ITEMS;
  const hiddenItemsCount = items.length - MAX_ITEMS;
  
  const itemsHTML = displayItems.map(item => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px 12px;">${escapeHtml(item.product_code || '-')}</td>
        <td style="padding: 8px 12px;">${escapeHtml(item.product_name)}</td>
        <td style="padding: 8px 12px; text-align: center;">${item.actual_order}</td>
        <td style="padding: 8px 12px; text-align: center;">${escapeHtml(item.order_by || 'Unit')}</td>
      </tr>
  `).join('');

  const formattedDate = order_date ? new Date(order_date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }) : 'N/A';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Purchase Order ${escapeHtml(order_number)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc;">
  <div style="max-width: 900px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); padding: 30px; border-radius: 12px 12px 0 0; color: white;">
      <h1 style="margin: 0; font-size: 28px; font-weight: 600;">Purchase Order</h1>
      <p style="margin: 10px 0 0 0; font-size: 24px; font-weight: 500; opacity: 0.95;">#${escapeHtml(order_number)}</p>
    </div>
    
    <!-- Body -->
    <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
      <!-- Order Info -->
      <div style="margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #e2e8f0;">
        <div style="display: flex; justify-content: space-between; flex-wrap: wrap;">
          <div style="margin-bottom: 15px;">
            <strong style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">From:</strong>
            <p style="margin: 5px 0 0 0; font-size: 16px; color: #1e293b; font-weight: 500;">${escapeHtml(store_name)}</p>
          </div>
          <div style="margin-bottom: 15px;">
            <strong style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">To:</strong>
            <p style="margin: 5px 0 0 0; font-size: 16px; color: #1e293b; font-weight: 500;">${escapeHtml(vendor_name)}</p>
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; flex-wrap: wrap; margin-top: 15px;">
          <div>
            <strong style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Order Date:</strong>
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #475569;">${formattedDate}</p>
          </div>
          <div>
            <strong style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Total Items:</strong>
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #475569; font-weight: 600;">${total_items || items.length}</p>
          </div>
        </div>
      </div>

      <!-- Items Table -->
      ${items.length > 0 ? `
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 12px; text-align: left; font-weight: 600; color: #475569;">Code</th>
              <th style="padding: 12px; text-align: left; font-weight: 600; color: #475569;">Product</th>
              <th style="padding: 12px; text-align: center; font-weight: 600; color: #475569;">Quantity</th>
              <th style="padding: 12px; text-align: center; font-weight: 600; color: #475569;">Unit</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
      </div>
      ` : '<p style="text-align: center; color: #64748b;">No items in this order</p>'}

      ${hasMoreItems ? `
      <div style="margin-top: 20px; padding: 12px; background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px;">
        <p style="margin: 0; color: #92400e; font-size: 13px;">
          <strong>Note:</strong> This order contains ${hiddenItemsCount} more items not shown in this email.
          Please log into the system to view the complete order details.
        </p>
      </div>
      ` : ''}

      <!-- Footer Note -->
      <div style="margin-top: 30px; padding: 20px; background-color: #f8fafc; border-radius: 8px; font-size: 13px; color: #475569;">
        <p style="margin: 0;"><strong>📋 Important:</strong> This is an automated purchase order from our Inventory Management System.</p>
        <p style="margin: 10px 0 0 0; font-size: 12px;">Please review the order and confirm receipt with an estimated delivery date.</p>
      </div>
    </div>
    
    <!-- Email Footer -->
    <div style="text-align: center; margin-top: 20px; padding: 20px; font-size: 12px; color: #94a3b8;">
      <p style="margin: 5px 0;">This email was sent from ${escapeHtml(store_name)}</p>
      <p style="margin: 5px 0;">Inventory Management System</p>
    </div>
  </div>
</body>
</html>`;
};

/**
 * Enviar email de orden de compra
 */
const sendOrderEmail = async (orderData) => {
  const { vendor_email, order_number, store_name, items } = orderData;

  if (!vendor_email) {
    throw new Error('Vendor email is required');
  }

  console.log(`📧 Preparing email for order ${order_number} to ${vendor_email} with ${items?.length || 0} items`);

  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || 'Inventory System'}" <${process.env.EMAIL_USER}>`,
    to: vendor_email,
    subject: `Purchase Order ${order_number} from ${store_name}`,
    html: generateOrderEmailHTML(orderData),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent successfully: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email send error:', error.message);
    throw error;
  }
};

module.exports = {
  sendOrderEmail,
};