/**
 * Shared email building blocks for every module: the Resend client, tracked
 * sending (EmailLog), the "Business <no-reply>" sender and the common layout.
 */
const { Resend } = require('resend');
const { sendTrackedEmail } = require('./emailDelivery');
const { escapeHtml } = require('../lib/escapeHtml');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.RESEND_FROM_SYSTEM || 'Reservas <noreply@resend.dev>';

// Builds a "Business Name <same-email>" from header for business emails
function fromBusiness(businessName) {
  const match = FROM.match(/<(.+)>/);
  const email = match ? match[1] : FROM;
  const safeName = String(businessName || '').replace(/[<>"\r\n]/g, '').trim() || 'Reservas';
  return `${safeName} <${email}>`;
}

function sendEmail(payload, source, metadata = null) {
  return sendTrackedEmail({ resend, payload, source, metadata });
}

// ---- helpers ----------------------------------------------------------------

function fmtDate(dateStr) {
  // dateStr = 'YYYY-MM-DD'
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// `title` is the header text; restaurant emails keep the original default.
function baseLayout(accentColor, content, title = 'Confirmación de reserva') {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reserva</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
          <!-- Header bar -->
          <tr>
            <td style="background:${accentColor};padding:24px 32px;">
              <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;">${escapeHtml(title)}</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:28px 32px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:16px 32px 20px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                Este correo ha sido generado automáticamente, por favor no respondas a este mensaje.
              </p>
              <p style="margin:10px 0 0;font-size:11px;color:#d1d5db;text-align:center;">
                Powered by <a href="${process.env.LANDING_URL || 'https://vetrareserve.com'}" style="color:#7C3AED;text-decoration:none;font-weight:600;">Vetra</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function detailRow(label, value) {
  return `
  <tr>
    <td style="padding:6px 0;font-size:13px;color:#6b7280;width:110px;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:600;">${escapeHtml(value)}</td>
  </tr>`;
}

// ---- templates --------------------------------------------------------------

module.exports = { fromBusiness, sendEmail, fmtDate, baseLayout, detailRow };
