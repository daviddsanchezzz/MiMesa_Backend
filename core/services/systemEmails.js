/**
 * Platform emails that are not tied to any vertical: the contact form and the
 * "new business signed up" alert for the Vetra team.
 */
const { escapeHtml } = require('../lib/escapeHtml');
const { sendEmail, detailRow } = require('./emailKit');

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

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr><td style="background:#7C3AED;padding:24px 32px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;">Nuevo mensaje de contacto</p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">De</p>
              <p style="margin:4px 0 0;font-size:15px;color:#111827;font-weight:600;">${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
            </td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Asunto</p>
              <p style="margin:4px 0 0;font-size:15px;color:#111827;">${escapeHtml(subject)}</p>
            </td></tr>
            <tr><td style="padding:16px 0 0;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Mensaje</p>
              <p style="margin:8px 0 0;font-size:15px;color:#374151;line-height:1.7;white-space:pre-line;">${escapeHtml(message)}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">Puedes responder directamente a <a href="mailto:${escapeHtml(email)}" style="color:#7C3AED;">${escapeHtml(email)}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr><td style="background:#4f46e5;padding:24px 32px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;">Nuevo negocio creado en Vetra</p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 18px;font-size:14px;color:#374151;line-height:1.6;">
            Se ha unido una nueva empresa a la plataforma.
          </p>

          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Empresa</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:14px 18px;margin-bottom:16px;">
            <tr><td>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${detailRow('Nombre', safeBusinessName)}
                ${detailRow('Email', safeBusinessEmail)}
                ${detailRow('Teléfono', safeBusinessPhone)}
                ${detailRow('CIF/NIF', safeBusinessCif)}
                ${detailRow('Business ID', safeBusinessId)}
              </table>
            </td></tr>
          </table>

          <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Owner</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:14px 18px;">
            <tr><td>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${detailRow('Nombre', safeOwnerName)}
                ${detailRow('Email', safeOwnerEmail)}
                ${detailRow('Teléfono', safeOwnerPhone)}
                ${detailRow('User ID', safeOwnerId)}
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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
