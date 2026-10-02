/**
 * Emails about the business's own Vetra subscription.
 */
const BusinessMember = require('../models/BusinessMember');
const { sendEmail } = require('./emailKit');
const { PAYMENT_GRACE_DAYS } = require('../lib/planCapabilities');
const d = require('./emailDesign');
const { escapeHtml } = require('../lib/escapeHtml');

function appUrl() {
  return (process.env.FRONTEND_URL || 'https://app.vetrareserve.com').replace(/\/+$/, '');
}

function emailEnabled() {
  const key = process.env.RESEND_API_KEY;
  return Boolean(key) && key !== 'your_resend_api_key_here';
}

/** Pure: the email for a failed subscription charge. */
function buildPaymentFailedEmail(business, { amount = null, now = new Date() } = {}) {
  const until = new Date(now.getTime() + PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000)
    .toLocaleDateString('es-ES', { day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' });
  const money = amount ? ` de ${(amount / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : '';
  const title = 'No hemos podido cobrar tu suscripción';
  const html = d.layout({
    brand: d.VETRA_BRAND,
    title,
    preheader: `Actualiza tu tarjeta antes del ${until} para no perder funciones.`,
    content: `${d.h1(title)}
      ${d.p(`El cobro${money} de la suscripción de <strong>${escapeHtml(business.name || '')}</strong> no se ha podido hacer. Suele ser una tarjeta caducada o sin saldo.`)}
      ${d.p(`Todo sigue funcionando igual hasta el <strong>${until}</strong>. Volveremos a intentar el cobro estos días; si antes actualizas la tarjeta, se arregla al momento.`)}
      ${d.buttons([{ href: `${appUrl()}/configuracion?tab=suscripcion`, label: 'Actualizar la tarjeta' }], d.VETRA_BRAND.color)}`,
    footer: { replyHint: true },
  });
  return { subject: `${title} · ${business.name || 'Vetra'}`, html };
}

async function sendPaymentFailed(business, invoice = {}) {
  if (!emailEnabled()) return false;
  const owners = await BusinessMember.find({ businessId: business._id, role: 'owner', status: { $ne: 'invited' } }).select('userEmail').lean();
  const to = [...new Set([...owners.map((o) => o.userEmail), business.email].filter(Boolean))];
  if (!to.length) return false;
  const { subject, html } = buildPaymentFailedEmail(business, { amount: invoice.amount_due || null });
  await sendEmail({ from: process.env.RESEND_FROM_SYSTEM || 'Vetra <onboarding@resend.dev>', to, subject, html },
    'billing.payment_failed', { businessId: String(business._id) });
  return true;
}

module.exports = { buildPaymentFailedEmail, sendPaymentFailed };
