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

// Generic layout for emails without a specific design (internal/system ones).
// `title` is shown as the heading; the brand colour is the accent.
function baseLayout(accentColor, content, title = 'Confirmación de reserva') {
  const design = require('./emailDesign');
  return design.layout({
    brand: { ...design.VETRA_BRAND, color: design.normalizeHex(accentColor, design.VIOLET) },
    preheader: title,
    title,
    content: design.h1(title) + content,
  });
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
