/**
 * Emails sent by the restaurant vertical: confirmations, status changes,
 * reminders, pending approval, alternative proposals and staff notifications.
 * They share the design of every Vetra email (core/services/emailDesign).
 */
const Business = require('../../../core/models/Business');
const { escapeHtml: esc } = require('../../../core/lib/escapeHtml');
const { businessTimezone, zonedDateTimeToUtc } = require('../../../core/lib/timezone');
const { businessLogoUrl } = require('../../../core/lib/images');
const { fromBusiness, sendEmail } = require('../../../core/services/emailKit');
const d = require('../../../core/services/emailDesign');

const DEFAULT_DURATION_MIN = 90;

function emailOn() {
  return Boolean(process.env.RESEND_API_KEY) && process.env.RESEND_API_KEY !== 'your_resend_api_key_here';
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || process.env.BASE_URL || 'https://app.vetrareserve.com').replace(/\/+$/, '');
}

function appUrl() {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.vetrareserve.com').replace(/\/+$/, '');
}

function buildCancelPath({ reservationId, guestEmail, publicToken }) {
  if (publicToken) {
    return `/public/cancel?reservationId=${reservationId}&token=${encodeURIComponent(publicToken)}`;
  }
  // Legacy reservations created before tokens existed
  return `/public/cancel?reservationId=${reservationId}&email=${encodeURIComponent(guestEmail)}`;
}

function cancelUrlOf(reservation) {
  return frontendUrl() + buildCancelPath({
    reservationId: reservation._id, guestEmail: reservation.guestEmail, publicToken: reservation.publicToken,
  });
}

// Callers load the business with different fields; complete what the design needs.
async function brandingFor(business) {
  const plain = typeof business?.toObject === 'function' ? business.toObject() : (business || {});
  // No database (tests) or an id that is not a real one: use what we were given.
  if (!plain._id || Business.db.readyState !== 1) return plain;
  try {
    const full = await Business.findById(plain._id)
      .select('name email phone address brandColor logoUpdatedAt timezone reservationDuration').lean();
    return { ...(full || {}), ...plain };
  } catch {
    return plain;
  }
}

function peopleText(n) {
  return `${n} ${Number(n) === 1 ? 'persona' : 'personas'}`;
}

function tableTitle(people) {
  return `Mesa para ${peopleText(people)}`;
}

function eventTimes(reservation, business) {
  const tz = businessTimezone(business);
  const start = zonedDateTimeToUtc(reservation.date, reservation.time, tz);
  const minutes = business.reservationDuration || DEFAULT_DURATION_MIN;
  return { start, end: new Date(start.getTime() + minutes * 60000) };
}

function calendarTitle(reservation, business) {
  return `Reserva en ${business.name} (${peopleText(reservation.people)})`;
}

function addressRow(business, color) {
  if (!business.address) return null;
  return {
    label: 'Dónde',
    valueHtml: `${esc(business.address)}<br><a href="${esc(d.mapsUrl(business.address))}" target="_blank" style="color:${color};font-weight:600;text-decoration:none;font-size:13px;">Cómo llegar</a>`,
  };
}

function customerLayout(business, { title, preheader, content }) {
  return d.layout({
    brand: d.brandOf(business, { logoUrl: businessLogoUrl(business) }),
    title,
    preheader,
    content,
    footer: { replyHint: true },
  });
}

// ---- customer templates -----------------------------------------------------

/** kind: confirmed (new or approved) | cancelled | pending | reminder | proposal. Pure. */
function buildCustomerEmail(kind, { reservation, business }) {
  const brand = d.brandOf(business, { logoUrl: businessLogoUrl(business) });
  const color = brand.color;
  const name = esc(d.firstName(reservation.guestName));
  const hello = name ? `Hola ${name}` : 'Hola';
  const biz = esc(business.name || '');
  const whenLong = d.dateParts(reservation.date).long;
  const room = reservation.roomId?.name || reservation.roomName || '';
  const lines = [`${reservation.time}${room ? ` · ${room}` : ''}`];
  const rows = [reservation.notes ? { label: 'Notas', value: reservation.notes } : null, addressRow(business, color)];
  const cancelUrl = cancelUrlOf(reservation);
  const { start, end } = eventTimes(reservation, business);
  const calendarUrl = d.googleCalendarUrl({
    title: calendarTitle(reservation, business), start, end,
    location: business.address || business.name, details: `Para cancelar: ${cancelUrl}`,
  });

  if (kind === 'proposal') {
    const alt = reservation.proposedAlternative || {};
    const content = `${d.h1('Te proponemos otro horario')}
      ${d.p(`${hello}, no podemos confirmarte la hora que pediste en <strong>${biz}</strong>, pero tenemos sitio en este otro momento:`)}
      ${d.eventCard({ localDate: alt.date, title: tableTitle(reservation.people), lines: [alt.time], color })}
      ${d.small(`Tu petición original: ${esc(d.dateParts(reservation.date).long)} a las ${esc(reservation.time)}.`)}
      ${alt.message ? d.notice(`<strong>Mensaje de ${biz}:</strong><br>${esc(alt.message).replace(/\r?\n/g, '<br>')}`, 'info') : ''}
      ${d.p(`¿Te va bien? ${business.email ? 'Responde a este email' : 'Contacta con el restaurante'}${business.phone ? ` o llama al <a href="${esc(d.telHref(business.phone))}" style="color:${color};font-weight:600;text-decoration:none;">${esc(business.phone)}</a>` : ''} para confirmarlo.`, { margin: '18px 0 0' })}`;
    return {
      subject: `Propuesta de nuevo horario - ${business.name}`,
      html: customerLayout(business, { title: 'Te proponemos otro horario', preheader: `${d.dateParts(alt.date).long} a las ${alt.time}`, content }),
    };
  }

  const copy = {
    confirmed: {
      subject: `Reserva confirmada - ${business.name}`,
      title: '¡Reserva confirmada!',
      preheader: `${whenLong} a las ${reservation.time} · ${peopleText(reservation.people)}. Te esperamos.`,
      intro: `${hello}, tu reserva en <strong>${biz}</strong> está confirmada. Te esperamos.`,
      actions: d.buttons([{ href: calendarUrl, label: 'Añadir al calendario' }, { href: cancelUrl, label: 'Cancelar reserva' }], color),
      after: d.small('¿Cambio de planes? Cancela desde el botón con antelación para que otra persona pueda aprovechar la mesa.'),
    },
    cancelled: {
      subject: `Reserva cancelada - ${business.name}`,
      title: 'Reserva cancelada',
      preheader: `Tu reserva del ${whenLong.toLowerCase()} a las ${reservation.time} se ha cancelado.`,
      intro: `${hello}, tu reserva en <strong>${biz}</strong> se ha cancelado. Si crees que es un error, contacta con nosotros.`,
      actions: business._id ? d.buttons([{ href: `${frontendUrl()}/public/${business._id}/reserve`, label: 'Hacer otra reserva' }], color) : '',
      after: '',
    },
    pending: {
      subject: `Reserva pendiente - ${business.name}`,
      title: 'Hemos recibido tu reserva',
      preheader: 'Te avisaremos por email en cuanto el restaurante la confirme.',
      intro: `${hello}, tu reserva en <strong>${biz}</strong> está pendiente de confirmar.`,
      actions: d.notice(`${biz} la revisará en breve y te enviaremos otro email con la respuesta.`, 'info'),
      after: '',
    },
    reminder: {
      subject: `Recordatorio de reserva - ${business.name}`,
      title: 'Te esperamos pronto',
      preheader: `${whenLong} a las ${reservation.time} · ${peopleText(reservation.people)}`,
      intro: `${hello}, te recordamos tu reserva en <strong>${biz}</strong>.`,
      actions: d.buttons([
        business.address ? { href: d.mapsUrl(business.address), label: 'Cómo llegar' } : null,
        { href: cancelUrl, label: 'Cancelar reserva', variant: business.address ? 'secondary' : 'primary' },
      ], color),
      after: d.small('Si no puedes venir, cancela desde el botón para que otra persona pueda usar la mesa.'),
    },
  }[kind];

  const content = `${d.h1(copy.title)}${d.p(copy.intro)}
    ${d.eventCard({ localDate: reservation.date, title: tableTitle(reservation.people), lines, rows: kind === 'cancelled' ? [] : rows, color, muted: kind === 'cancelled' })}
    ${copy.actions}${copy.after}`;
  return { subject: copy.subject, html: customerLayout(business, { title: copy.title, preheader: copy.preheader, content }) };
}

function buildInvite(reservation, business) {
  const { start, end } = eventTimes(reservation, business);
  const content = d.icsInvite({
    uid: `reservation-${reservation._id}`,
    title: calendarTitle(reservation, business),
    start, end,
    location: business.address || business.name,
    description: `Para cancelar: ${cancelUrlOf(reservation)}`,
    organizerName: business.name,
    stamp: reservation.createdAt || null,
  });
  return { filename: 'reserva.ics', content: Buffer.from(content).toString('base64'), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' };
}

async function sendToGuest(kind, reservation, business, source, metadata = {}) {
  const to = reservation.guestEmail;
  if (!to || !emailOn()) return null;
  const biz = await brandingFor(business);
  const { subject, html } = buildCustomerEmail(kind, { reservation, business: biz });
  const payload = { from: fromBusiness(biz.name), to, replyTo: biz.email || undefined, subject, html };
  if (kind === 'confirmed') payload.attachments = [buildInvite(reservation, biz)];
  const result = await sendEmail(payload, source, {
    businessId: biz?._id ? String(biz._id) : null,
    reservationId: reservation?._id ? String(reservation._id) : null,
    ...metadata,
  });
  if (result?.error) console.error('[email] Resend error:', JSON.stringify(result.error));
  return result;
}

async function sendReservationConfirmation(reservation, business) {
  await sendToGuest('confirmed', reservation, business, 'reservation.confirmation');
}

/** Status-change email (confirmed / cancelled). */
async function sendStatusUpdate(reservation, business, newStatus) {
  if (!['confirmed', 'cancelled'].includes(newStatus)) return;
  try {
    await sendToGuest(newStatus, reservation, business, 'reservation.status_update', { status: newStatus });
  } catch (err) {
    console.error('[email] sendStatusUpdate failed:', err.message);
  }
}

async function sendReservationPendingEmail(reservation, business) {
  await sendToGuest('pending', reservation, business, 'reservation.pending');
}

async function sendAlternativeProposalEmail(reservation, business) {
  const alt = reservation.proposedAlternative || {};
  if (!alt.date || !alt.time) return;
  await sendToGuest('proposal', reservation, business, 'reservation.alternative_proposal');
}

async function sendReservationReminderEmail(reservation, business) {
  await sendToGuest('reminder', reservation, business, 'reservation.reminder');
}

// ---- team templates ---------------------------------------------------------

function guestDetails(reservation, color) {
  return d.details([
    { label: 'Cliente', value: reservation.guestName || '-' },
    reservation.guestPhone ? { label: 'Teléfono', valueHtml: `<a href="${esc(d.telHref(reservation.guestPhone))}" style="color:${color};text-decoration:none;">${esc(reservation.guestPhone)}</a>` } : null,
    reservation.guestEmail ? { label: 'Email', valueHtml: `<a href="mailto:${esc(reservation.guestEmail)}" style="color:${color};text-decoration:none;">${esc(reservation.guestEmail)}</a>` } : null,
    reservation.notes ? { label: 'Notas', value: reservation.notes } : null,
  ]);
}

function teamLayout(business, { title, preheader, content }) {
  return d.layout({
    brand: d.brandOf(business, { logoUrl: businessLogoUrl(business) }),
    title,
    preheader,
    content,
    footer: { note: `Recibes este aviso porque gestionas ${esc(business.name || '')} en Vetra. Puedes desactivarlo en tu Perfil.` },
  });
}

/** eventType: created | cancelled. Pure. */
function buildStaffEmail(eventType, { reservation, business, customerStats = null }) {
  const color = d.brandOf(business).color;
  const cancelled = eventType === 'cancelled';
  const title = cancelled ? 'Reserva cancelada' : 'Nueva reserva';
  const room = reservation.roomId?.name || 'Sin sala';
  const table = reservation.tableId?.name || 'Sin mesa';
  const history = customerStats && (customerStats.noShowCount > 0 || customerStats.cancellationCount > 0)
    ? d.notice(`<strong>Ojo con este cliente:</strong> ${[
      customerStats.noShowCount > 0 ? `${customerStats.noShowCount} ${customerStats.noShowCount === 1 ? 'vez no vino' : 'veces no vino'}` : '',
      customerStats.cancellationCount > 0 ? `${customerStats.cancellationCount} ${customerStats.cancellationCount === 1 ? 'cancelación' : 'cancelaciones'}` : '',
    ].filter(Boolean).join(' · ')}.`, 'warning')
    : '';
  const content = `${d.h1(title)}
    ${d.p(cancelled ? 'Un cliente ha cancelado su reserva. La mesa vuelve a estar libre.' : 'Tienes una nueva reserva.')}
    ${d.eventCard({ localDate: reservation.date, title: tableTitle(reservation.people), lines: [`${reservation.time} · ${room} · ${table}`], color, muted: cancelled })}
    ${d.card(guestDetails(reservation, color))}
    ${history}
    ${d.buttons([{ href: `${appUrl()}/reservations`, label: 'Ver reservas' }], color)}`;
  return {
    subject: `${title} - ${business.name}`,
    html: teamLayout(business, { title, preheader: `${reservation.guestName || 'Cliente'} · ${d.dateParts(reservation.date).long} ${reservation.time} · ${peopleText(reservation.people)}`, content }),
  };
}

async function sendStaffReservationNotification(recipients, reservation, business, eventType, customerStats = null) {
  if (!Array.isArray(recipients) || recipients.length === 0) return;
  if (!emailOn()) return;
  const biz = await brandingFor(business);
  const { subject, html } = buildStaffEmail(eventType, { reservation, business: biz, customerStats });
  try {
    await sendEmail({ from: fromBusiness(biz.name), to: recipients, replyTo: reservation.guestEmail || undefined, subject, html },
      'reservation.staff_notification', {
        businessId: biz?._id ? String(biz._id) : null,
        reservationId: reservation?._id ? String(reservation._id) : null,
        eventType,
      });
  } catch (err) {
    console.error('[email] sendStaffReservationNotification failed:', err.message);
  }
}

/** Pure. */
function buildPendingApprovalEmail({ reservation, business }) {
  const color = d.brandOf(business).color;
  const reason = reservation.pendingReason === 'large_group' ? 'Es un grupo grande.'
    : reservation.pendingReason === 'slot_capacity' ? 'Ese turno está casi lleno.' : '';
  const content = `${d.h1('Reserva pendiente de aprobación')}
    ${d.p('Una nueva reserva necesita tu aprobación antes de confirmarse. El cliente espera tu respuesta.')}
    ${d.eventCard({ localDate: reservation.date, title: tableTitle(reservation.people), lines: [reservation.time], color })}
    ${d.card(guestDetails(reservation, color))}
    ${reason ? d.notice(`<strong>Por qué está pendiente:</strong> ${reason}`, 'warning') : ''}
    ${d.buttons([{ href: `${appUrl()}/reservations`, label: 'Revisar reserva' }], color)}`;
  return {
    subject: `Reserva pendiente de aprobación - ${business.name}`,
    html: teamLayout(business, { title: 'Reserva pendiente de aprobación', preheader: `${reservation.guestName || 'Cliente'} · ${d.dateParts(reservation.date).long} ${reservation.time}`, content }),
  };
}

async function sendPendingApprovalStaffNotification(recipients, reservation, business) {
  if (!Array.isArray(recipients) || recipients.length === 0) return;
  if (!emailOn()) return;
  const biz = await brandingFor(business);
  const { subject, html } = buildPendingApprovalEmail({ reservation, business: biz });
  try {
    await sendEmail({ from: fromBusiness(biz.name), to: recipients, replyTo: reservation.guestEmail || undefined, subject, html },
      'reservation.pending_approval_staff', {
        businessId: biz?._id ? String(biz._id) : null,
        reservationId: reservation?._id ? String(reservation._id) : null,
      });
  } catch (err) {
    console.error('[email] sendPendingApprovalStaffNotification failed:', err.message);
  }
}

module.exports = {
  buildCustomerEmail,
  buildStaffEmail,
  buildPendingApprovalEmail,
  sendReservationConfirmation,
  sendStatusUpdate,
  sendStaffReservationNotification,
  sendPendingApprovalStaffNotification,
  sendReservationPendingEmail,
  sendAlternativeProposalEmail,
  sendReservationReminderEmail,
};
