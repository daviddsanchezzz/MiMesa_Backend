const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.RESEND_FROM_SYSTEM || 'Reservas <noreply@resend.dev>';

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  // dateStr = 'YYYY-MM-DD'
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function baseLayout(accentColor, content) {
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
              <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;">Confirmación de reserva</p>
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
                Powered by <a href="${process.env.LANDING_URL || 'https://tableo.app'}" style="color:#7C3AED;text-decoration:none;font-weight:600;">Tableo</a>
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
    <td style="padding:6px 0;font-size:13px;color:#6b7280;width:110px;vertical-align:top;">${label}</td>
    <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:600;">${value}</td>
  </tr>`;
}

// ── TEMPLATES ────────────────────────────────────────────────────────────────

function buildConfirmationEmail({ businessName, accentColor, guestName, date, time, people, roomName, notes, reservationId, guestEmail, businessEmail, businessPhone }) {
  const accent = accentColor || '#4f46e5';
  const details = [
    detailRow('Fecha',    fmtDate(date)),
    detailRow('Hora',     time),
    detailRow('Personas', `${people} ${people === 1 ? 'persona' : 'personas'}`),
    roomName ? detailRow('Sala', roomName) : '',
    notes    ? detailRow('Notas',  notes)  : '',
  ].join('');

  // build a cancel link that's safe to click from email
  const cancelUrl =
    (process.env.FRONTEND_URL || process.env.BASE_URL || 'https://example.com') +
    `/public/cancel?reservationId=${reservationId}&email=${encodeURIComponent(guestEmail)}`;

  const contactInfo = [];
  if (businessEmail) contactInfo.push(`Email: ${businessEmail}`);
  if (businessPhone) contactInfo.push(`Teléfono: ${businessPhone}`);
  const contactSection = contactInfo.length > 0 ? `
    <p style="margin:16px 0 0;font-size:14px;color:#374151;line-height:1.6;">
      <strong>Contacto del restaurante:</strong><br>
      ${contactInfo.join('<br>')}
    </p>` : '';

  const body = `
    <p style="margin:0 0 20px;font-size:16px;color:#111827;">
      Hola, <strong>${guestName}</strong>
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#374151;line-height:1.6;">
      Tu reserva en <strong>${businessName}</strong> ha sido <strong>confirmada</strong>.
      A continuación encontrarás los detalles:
    </p>
    <!-- Details box -->
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${details}
        </table>
      </td></tr>
    </table>
    <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">
      Si necesitas hacer algún cambio o cancelar tu reserva, puedes usar el botón a continuación:
    </p>
    <p style="margin:16px 0;text-align:center;">
      <a href="${cancelUrl}"
         style="display:inline-block;padding:12px 24px;background:${accent};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
        Cancelar mi reserva
      </a>
    </p>${contactSection}`;

  return {
    subject: `Reserva confirmada — ${businessName}`,
    html: baseLayout(accent, body),
  };
}

function buildStatusEmail({ businessName, accentColor, guestName, date, time, people, status, reservationId, guestEmail, businessEmail, businessPhone }) {
  const accent = accentColor || '#4f46e5';
  const statusMessages = {
    confirmed: { title: 'Reserva confirmada', msg: 'Tu reserva ha sido <strong>confirmada</strong>. Te esperamos.' },
    cancelled: { title: 'Reserva cancelada', msg: 'Tu reserva ha sido <strong>cancelada</strong>. Si crees que es un error, contacta con nosotros.' },
  };
  const { title, msg } = statusMessages[status] || {};
  if (!title) return null;

  const cancelUrl =
    (process.env.FRONTEND_URL || process.env.BASE_URL || 'https://example.com') +
    `/public/cancel?reservationId=${reservationId}&email=${encodeURIComponent(guestEmail)}`;

  const contactInfo = [];
  if (businessEmail) contactInfo.push(`Email: ${businessEmail}`);
  if (businessPhone) contactInfo.push(`Tel�fono: ${businessPhone}`);
  const contactSection = contactInfo.length > 0 ? `
    <p style="margin:16px 0 0;font-size:14px;color:#374151;line-height:1.6;">
      <strong>Contacto del restaurante:</strong><br>
      ${contactInfo.join('<br>')}
    </p>` : '';

  const cancelSection = status === 'cancelled' ? '' : `
    <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">
      Si deseas cancelar tu reserva, haz clic en el bot�n a continuaci�n:
    </p>
    <p style="margin:16px 0;text-align:center;">
      <a href="${cancelUrl}"
         style="display:inline-block;padding:12px 24px;background:${accent};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
        Cancelar reserva
      </a>
    </p>`;

  const body = `
    <p style="margin:0 0 20px;font-size:16px;color:#111827;">
      Hola, <strong>${guestName}</strong>
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#374151;line-height:1.6;">
      ${msg}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${detailRow('Restaurante', businessName)}
          ${detailRow('Fecha', fmtDate(date))}
          ${detailRow('Hora', time)}
          ${detailRow('Personas', `${people} ${people === 1 ? 'persona' : 'personas'}`)}
        </table>
      </td></tr>
    </table>
    ${cancelSection}${contactSection}`;

  return {
    subject: `${title} � ${businessName}`,
    html: baseLayout(accent, body),
  };
}
async function sendReservationConfirmation(reservation, business) {
  const to = reservation.guestEmail;
  console.log('[email] sendReservationConfirmation → to:', to, '| key set:', !!process.env.RESEND_API_KEY);
  if (!to || !process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here') return;

  const { subject, html } = buildConfirmationEmail({
    businessName: business.name,
    accentColor:  business.brandColor,
    guestName:    reservation.guestName,
    date:         reservation.date,
    time:         reservation.time,
    people:       reservation.people,
    roomName:     reservation.roomId?.name || null,
    notes:        reservation.notes || null,
    reservationId: reservation._id,
    guestEmail: reservation.guestEmail,
    businessEmail: business.email,
    businessPhone: business.phone,
  });

  console.log('[email] sending to', to, '| subject:', subject, '| from:', FROM);
  const result = await resend.emails.send({ from: FROM, to, subject, html });
  if (result.error) {
    console.error('[email] Resend error:', JSON.stringify(result.error));
  } else {
    console.log('[email] sent OK, id:', result.data?.id);
  }
}

/**
 * Send status-change email (confirmed / cancelled).
 */
async function sendStatusUpdate(reservation, business, newStatus) {
  const to = reservation.guestEmail;
  if (!to || !process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here') return;

  const result = buildStatusEmail({
    businessName: business.name,
    accentColor:  business.brandColor,
    guestName:    reservation.guestName,
    date:         reservation.date,
    time:         reservation.time,
    people:       reservation.people,
    status:       newStatus,
    reservationId: reservation._id,
    guestEmail: reservation.guestEmail,
    businessEmail: business.email,
    businessPhone: business.phone,
  });
  if (!result) return;

  try {
    await resend.emails.send({ from: FROM, to, subject: result.subject, html: result.html });
  } catch (err) {
    console.error('[email] sendStatusUpdate failed:', err.message);
  }
}

async function sendStaffReservationNotification(recipients, reservation, business, eventType) {
  if (!Array.isArray(recipients) || recipients.length === 0) return;
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here') return;

  const title = eventType === 'cancelled' ? 'Reserva cancelada' : 'Nueva reserva';
  const subject = `${title} - ${business.name}`;
  const roomName = reservation.roomId?.name || 'Sin sala';
  const tableName = reservation.tableId?.name || 'Sin mesa';
  const guestEmail = reservation.guestEmail || '-';
  const guestPhone = reservation.guestPhone || '-';

  const html = baseLayout(
    business.brandColor || '#4f46e5',
    `
      <p style="margin:0 0 16px;font-size:16px;color:#111827;"><strong>${title}</strong></p>
      <table width="100%" cellpadding="0" cellspacing="0"
        style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${detailRow('Cliente', reservation.guestName || '-')}
            ${detailRow('Fecha', fmtDate(reservation.date))}
            ${detailRow('Hora', reservation.time || '-')}
            ${detailRow('Personas', String(reservation.people || '-'))}
            ${detailRow('Sala', roomName)}
            ${detailRow('Mesa', tableName)}
            ${detailRow('Email', guestEmail)}
            ${detailRow('Telefono', guestPhone)}
          </table>
        </td></tr>
      </table>
    `
  );

  try {
    await resend.emails.send({
      from: FROM,
      to: recipients,
      subject,
      html,
    });
  } catch (err) {
    console.error('[email] sendStaffReservationNotification failed:', err.message);
  }
}

module.exports = {
  sendReservationConfirmation,
  sendStatusUpdate,
  sendStaffReservationNotification,
};
