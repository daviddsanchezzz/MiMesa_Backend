/**
 * Platform emails that are not tied to any vertical: the contact form and the
 * "new business signed up" alert for the Vetra team.
 */
const { escapeHtml } = require('../lib/escapeHtml');
const { sendEmail } = require('./emailKit');
const d = require('./emailDesign');

async function sendContactEmail({ name, email, subject, message }) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here') {
    console.warn('[contact] RESEND_API_KEY not configured - email skipped');
    return;
  }
  const to = (process.env.DEV_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (to.length === 0) {
    console.warn('[contact] DEV_EMAILS not configured - email skipped');
    return;
  }

  const html = d.layout({
    brand: d.VETRA_BRAND,
    title: 'Nuevo mensaje de contacto',
    preheader: `${name}: ${subject}`,
    content: `${d.h1('Nuevo mensaje de contacto')}
      ${d.card(d.details([{ label: 'Nombre', value: name }, { label: 'Email', value: email }, { label: 'Asunto', value: subject }]), { margin: '8px 0 0' })}
      ${d.card(d.p(escapeHtml(message).replace(/\r?\n/g, '<br>'), { margin: '0' }), { background: '#ffffff' })}
      ${d.small('Responde a este email para contestar directamente.')}`,
  });

  const result = await sendEmail({
    from:     process.env.RESEND_FROM_SYSTEM || 'onboarding@resend.dev',
    to,
    replyTo:  email,
    subject:  `[Contacto Vetra] ${subject} - ${name}`,
    html,
  }, 'contact.form', { senderName: name, senderEmail: email });
  if (result.error) {
    console.error('[contact] Resend error:', JSON.stringify(result.error));
    throw new Error(result.error.message || 'Resend send failed');
  }
  console.log('[contact] email sent OK, id:', result.data?.id);
}

async function sendNewBusinessOwnerNotification({ business, owner }) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here') return;
  const to = (process.env.DEV_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (to.length === 0) return;

  const safeBusinessName = String(business?.name || '-');
  const safeBusinessEmail = String(business?.email || '-');
  const safeBusinessPhone = String(business?.phone || '-');
  const safeBusinessCif = String(business?.cif || '-');
  const safeBusinessId = String(String(business?._id || '-'));

  const safeOwnerName = String(owner?.name || '-');
  const safeOwnerEmail = String(owner?.email || '-');
  const safeOwnerId = String(owner?.id || '-');
  const safeOwnerPhone = String(owner?.phone || '-');

  const html = d.layout({
    brand: d.VETRA_BRAND,
    title: 'Nuevo negocio en Vetra',
    preheader: `${safeBusinessName} · ${safeOwnerEmail}`,
    content: `${d.h1('Nuevo negocio en Vetra')}
      ${d.p('Se ha unido una nueva empresa a la plataforma.')}
      ${d.p('<strong>Empresa</strong>', { margin: '18px 0 0' })}
      ${d.card(d.details([
        { label: 'Nombre', value: safeBusinessName }, { label: 'Email', value: safeBusinessEmail },
        { label: 'Teléfono', value: safeBusinessPhone }, { label: 'CIF/NIF', value: safeBusinessCif }, { label: 'Business ID', value: safeBusinessId },
      ]), { margin: '8px 0 0' })}
      ${d.p('<strong>Propietario</strong>', { margin: '18px 0 0' })}
      ${d.card(d.details([
        { label: 'Nombre', value: safeOwnerName }, { label: 'Email', value: safeOwnerEmail },
        { label: 'Teléfono', value: safeOwnerPhone }, { label: 'User ID', value: safeOwnerId },
      ]), { margin: '8px 0 0' })}`,
  });

  try {
    await sendEmail({
      from: process.env.RESEND_FROM_SYSTEM || 'Vetra <onboarding@resend.dev>',
      to,
      subject: `[Vetra] Nueva empresa: ${business?.name || 'Sin nombre'}`,
      html,
    }, 'business.new_owner_notification', {
      businessId: business?._id ? String(business._id) : null,
      ownerId: owner?.id || null,
    });
  } catch (err) {
    console.error('[email] sendNewBusinessOwnerNotification failed:', err.message);
  }
}

module.exports = { sendContactEmail, sendNewBusinessOwnerNotification };
