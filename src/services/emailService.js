const nodemailer = require('nodemailer');

// Configurar transporter
const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST,
  port:   process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Verificar configuración
transporter.verify((error, success) => {
  if (error) {
    console.error('Email configuration error:', error.message);
    console.error('Config being used:', {
      host:   process.env.EMAIL_HOST     || 'NOT SET',
      port:   process.env.EMAIL_PORT     || 'NOT SET',
      secure: process.env.EMAIL_SECURE   || 'NOT SET',
      user:   process.env.EMAIL_USER     || 'NOT SET',
      pass:   process.env.EMAIL_PASSWORD ? 'SET' : 'NOT SET',
    });
  } else {
    console.log('Email server ready to send messages');
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

const formatCurrency = (v) =>
  v !== null && v !== undefined ? `$${parseFloat(v).toFixed(2)}` : '—';

// ============================================================
// Generar HTML para el email de orden
// ============================================================
const generateOrderEmailHTML = (orderData) => {
  const { order_number, order_date, store_name, vendor_name, items, total_amount, total_items } = orderData;

  const MAX_ITEMS = 100;
  const displayItems     = items.slice(0, MAX_ITEMS);
  const hasMoreItems     = items.length > MAX_ITEMS;
  const hiddenItemsCount = items.length - MAX_ITEMS;

  const itemsHTML = displayItems.map(item => `
    <tr style="border-bottom: 1px solid #e2e8f0;">
      <td style="padding: 8px 12px;">${escapeHtml(item.product_code || '-')}</td>
      <td style="padding: 8px 12px;">${escapeHtml(item.product_name)}</td>
      <td style="padding: 8px 12px; text-align: center;">${item.actual_order}</td>
      <td style="padding: 8px 12px; text-align: center;">${escapeHtml(item.order_by || 'Unit')}</td>
    </tr>
  `).join('');

  const formattedDate = order_date
    ? new Date(order_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Purchase Order ${escapeHtml(order_number)}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#f8fafc;">
  <div style="max-width:900px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#0ea5e9 0%,#0284c7 100%);padding:30px;border-radius:12px 12px 0 0;color:white;">
      <h1 style="margin:0;font-size:28px;font-weight:600;">Purchase Order</h1>
      <p style="margin:10px 0 0 0;font-size:24px;font-weight:500;opacity:0.95;">#${escapeHtml(order_number)}</p>
    </div>
    <div style="background:white;padding:30px;border-radius:0 0 12px 12px;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
      <div style="margin-bottom:30px;padding-bottom:20px;border-bottom:2px solid #e2e8f0;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;">
          <div style="margin-bottom:15px;">
            <strong style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">From:</strong>
            <p style="margin:5px 0 0 0;font-size:16px;color:#1e293b;font-weight:500;">${escapeHtml(store_name)}</p>
          </div>
          <div style="margin-bottom:15px;">
            <strong style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">To:</strong>
            <p style="margin:5px 0 0 0;font-size:16px;color:#1e293b;font-weight:500;">${escapeHtml(vendor_name)}</p>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;margin-top:15px;">
          <div>
            <strong style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Order Date:</strong>
            <p style="margin:5px 0 0 0;font-size:14px;color:#475569;">${formattedDate}</p>
          </div>
          <div>
            <strong style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Total Items:</strong>
            <p style="margin:5px 0 0 0;font-size:14px;color:#475569;font-weight:600;">${total_items || items.length}</p>
          </div>
        </div>
      </div>

      ${items.length > 0 ? `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="background-color:#f8fafc;border-bottom:2px solid #e2e8f0;">
              <th style="padding:12px;text-align:left;font-weight:600;color:#475569;">Code</th>
              <th style="padding:12px;text-align:left;font-weight:600;color:#475569;">Product</th>
              <th style="padding:12px;text-align:center;font-weight:600;color:#475569;">Quantity</th>
              <th style="padding:12px;text-align:center;font-weight:600;color:#475569;">Unit</th>
            </tr>
          </thead>
          <tbody>${itemsHTML}</tbody>
        </table>
      </div>
      ` : '<p style="text-align:center;color:#64748b;">No items in this order</p>'}

      ${hasMoreItems ? `
      <div style="margin-top:20px;padding:12px;background-color:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;">
        <p style="margin:0;color:#92400e;font-size:13px;">
          <strong>Note:</strong> This order contains ${hiddenItemsCount} more items not shown in this email.
          Please log into the system to view the complete order details.
        </p>
      </div>
      ` : ''}

      <div style="margin-top:30px;padding:20px;background-color:#f8fafc;border-radius:8px;font-size:13px;color:#475569;">
        <p style="margin:0;"><strong>Important:</strong> This is an automated purchase order from our Kitchen Inventory Management System.</p>
        <p style="margin:10px 0 0 0;font-size:12px;">Please review the order and confirm receipt with an estimated delivery date.</p>
      </div>
    </div>
    <div style="text-align:center;margin-top:20px;padding:20px;font-size:12px;color:#94a3b8;">
      <p style="margin:5px 0;">This email was sent from ${escapeHtml(store_name)}</p>
      <p style="margin:5px 0;">Kitchen Inventory Management System</p>
    </div>
  </div>
</body>
</html>`;
};

// ============================================================
// Enviar email de orden de compra
// ============================================================
const sendOrderEmail = async (orderData) => {
  const { vendor_email, order_number, store_name, items } = orderData;

  if (!vendor_email) throw new Error('Vendor email is required');

  console.log(`Preparing email for order ${order_number} to ${vendor_email} with ${items?.length || 0} items`);

  const mailOptions = {
    from:    `"${process.env.EMAIL_FROM_NAME || ' Kitechen Inventory System'}" <${process.env.EMAIL_USER}>`,
    to:      vendor_email,
    subject: `Purchase Order ${order_number} from ${store_name}`,
    html:    generateOrderEmailHTML(orderData),
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

// ============================================================
// Enviar email de discrepancia de invoice (normal + no-order)
// ============================================================
const sendInvoiceDiscrepancyEmail = async ({
  recipients,
  order_number,
  vendor_name,
  store_name,
  discrepancies    = [],
  price_discrepancies = [],
  invoice_number   = null,
  receipt_url      = null,
  total_amount     = null,
  no_order         = false,
  items            = []   // solo usado en no_order
}) => {
  const toList = recipients.map(r => r.email).join(', ');

  // ── Subject ──────────────────────────────────────────────
  // Evita el "null" cuando no hay orden
  const subjectOrderPart = order_number ? order_number : 'No Order';
  const subjectPrefix    = no_order ? ' No-Order Invoice' : 'Invoice Discrepancy';
  const subject          = `${subjectPrefix} — ${subjectOrderPart} (${store_name})`;

  // ── Sección: productos del No-Order ──────────────────────
  const noOrderItemsSection = no_order && items.length > 0 ? `
    <h3 style="color:#1e293b;margin:24px 0 8px;font-size:14px;">Products Received</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:8px 12px;text-align:left;color:#475569;">Product</th>
          <th style="padding:8px 12px;text-align:center;color:#475569;">Qty Received</th>
          <th style="padding:8px 12px;text-align:center;color:#475569;">Unit Price</th>
          <th style="padding:8px 12px;text-align:center;color:#475569;">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => {
          const qty      = parseFloat(item.received_qty)  || 0;
          const price    = parseFloat(item.price_invoice) || 0;
          const subtotal = qty * price;
          return `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">
                ${escapeHtml(item.product_name)}
                ${item.product_code ? `<span style="font-size:11px;color:#94a3b8;margin-left:6px;">${escapeHtml(item.product_code)}</span>` : ''}
              </td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:600;">${qty}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${formatCurrency(price)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:600;color:#0ea5e9;">${formatCurrency(subtotal)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
      ${total_amount !== null ? `
      <tfoot>
        <tr style="background:#f8fafc;">
          <td colspan="3" style="padding:10px 12px;text-align:right;font-weight:700;color:#1e293b;">Total:</td>
          <td style="padding:10px 12px;text-align:center;font-weight:700;color:#0ea5e9;font-size:15px;">${formatCurrency(total_amount)}</td>
        </tr>
      </tfoot>
      ` : ''}
    </table>
  ` : '';

  // ── Sección: discrepancias de cantidad (solo modo normal) ─
  const discrepancySection = !no_order && discrepancies.length > 0 ? `
    <h3 style="color:#b45309;margin:0 0 8px;font-size:14px;">Quantity Discrepancies</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#fffbeb;">
          <th style="padding:8px 12px;text-align:left;color:#92400e;">Product</th>
          <th style="padding:8px 12px;text-align:center;color:#92400e;">Ordered</th>
          <th style="padding:8px 12px;text-align:center;color:#92400e;">Received</th>
          <th style="padding:8px 12px;text-align:center;color:#92400e;">Difference</th>
        </tr>
      </thead>
      <tbody>
        ${discrepancies.map(d => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(d.product_name)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${d.ordered_qty}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${d.received_qty}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;
                color:${d.difference < 0 ? '#ef4444' : '#22c55e'};font-weight:600;">
              ${d.difference > 0 ? '+' : ''}${d.difference}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  // ── Sección: cambios de precio ────────────────────────────
  const priceSection = price_discrepancies.length > 0 ? `
    <h3 style="color:#7c3aed;margin:24px 0 8px;font-size:14px;">Price Updates</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f5f3ff;">
          <th style="padding:8px 12px;text-align:left;color:#6d28d9;">Product</th>
          <th style="padding:8px 12px;text-align:center;color:#6d28d9;">Old Price</th>
          <th style="padding:8px 12px;text-align:center;color:#6d28d9;">New Price</th>
        </tr>
      </thead>
      <tbody>
        ${price_discrepancies.map(p => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(p.product_name)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">
              ${formatCurrency(p.price_app)}
            </td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;
                color:#7c3aed;font-weight:600;">
              ${formatCurrency(p.price_invoice)}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  // ── Sección: foto del recibo ──────────────────────────────
  const receiptSection = receipt_url ? `
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;">
      <p style="font-size:12px;font-weight:600;color:#475569;margin:0 0 8px;">📷 Receipt Photo:</p>
      <img src="${receipt_url}" alt="Receipt"
        style="max-width:100%;border-radius:8px;border:1px solid #e2e8f0;display:block;" />
    </div>
  ` : '';

  // ── Header color según tipo ───────────────────────────────
  const headerBg    = no_order ? '#7c3aed' : '#0ea5e9';
  const headerIcon  = no_order ? '' : '';
  const headerTitle = no_order ? 'No-Order Invoice' : 'Invoice Quantity Discrepancy';

  // ── HTML completo ─────────────────────────────────────────
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">

      <!-- Header -->
      <div style="background:${headerBg};padding:20px 24px;border-radius:8px 8px 0 0;">
        <h2 style="color:#fff;margin:0;font-size:18px;">${headerIcon} ${headerTitle}</h2>
        <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px;">${escapeHtml(store_name)}</p>
      </div>

      <!-- Body -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">

        <!-- Meta info -->
        <div style="margin-bottom:20px;">
          ${order_number ? `
          <p style="color:#475569;font-size:14px;margin:0 0 4px;">
            <strong>Order:</strong> ${escapeHtml(order_number)}
            ${invoice_number ? ` &nbsp;·&nbsp; <strong>Invoice #:</strong> ${escapeHtml(invoice_number)}` : ''}
          </p>
          ` : `
          <p style="color:#475569;font-size:14px;margin:0 0 4px;">
            <strong>Type:</strong>
            <span style="background:#f5f3ff;color:#7c3aed;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">
              No Order
            </span>
            ${invoice_number ? ` &nbsp;·&nbsp; <strong>Invoice #:</strong> ${escapeHtml(invoice_number)}` : ''}
          </p>
          `}
          <p style="color:#475569;font-size:14px;margin:0;">
            <strong>Vendor:</strong> ${escapeHtml(vendor_name)}
          </p>
          ${total_amount !== null && !no_order ? `
          <p style="color:#475569;font-size:14px;margin:4px 0 0;">
            <strong>Total:</strong>
            <span style="color:#0ea5e9;font-weight:700;">${formatCurrency(total_amount)}</span>
          </p>
          ` : ''}
        </div>

        <!-- Contenido según tipo -->
        ${noOrderItemsSection}
        ${discrepancySection}
        ${priceSection}
        ${receiptSection}

        <!-- Footer -->
        <p style="font-size:12px;color:#94a3b8;margin-top:24px;border-top:1px solid #f1f5f9;padding-top:16px;">
          This is an automated notification from your Inventory System.
        </p>
      </div>
    </div>
  `;

  const mailOptions = {
    from:    `"${process.env.EMAIL_FROM_NAME || 'Inventory System'}" <${process.env.EMAIL_USER}>`,
    to:      toList,
    subject,
    html
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Invoice email sent: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Invoice email error:', error.message);
    throw error;
  }
};

module.exports = {
  sendOrderEmail,
  sendInvoiceDiscrepancyEmail
};