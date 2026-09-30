/**
 * Emails for appointments (bookings module):
 *  - to the customer: confirmation (or "request received" when the business
 *    must approve), 24h reminder, cancellation — all with the cancel link
 *  - follow-ups (commercial, opt-out in every email): "te toca volver" and
 *    "¿qué tal tu visita?" with the business's Google review link
 *  - to the business team: new online booking and online cancellation
 *
 * Every function is safe to call fire-and-forget: it never throws.
 */
const Business = require('../../../core/models/Business');
const BusinessMember = require('../../../core/models/BusinessMember');
const { escapeHtml } = require('../../../core/lib/escapeHtml');
const { businessTimezone } = require('../../../core/lib/timezone');
const { fromBusiness, sendEmail, baseLayout, detailRow } = require('../../../core/services/emailKit');
const { businessLogoUrl } = require('../../../core/lib/images');
const Customer = require('../../../core/models/Customer');
const crypto = require('crypto');

const DEFAULT_ACCENT = '#7c3aed';

function emailEnabled() {
  const key = process.env.RESEND_API_KEY;
  return Boolean(key) && key !== 'your_resend_api_key_here';
}

function appUrl() {
  return (process.env.FRONTEND_URL || process.env.APP_URL || 'https://app.vetrareserve.com').replace(/\/+$/, '');
}

function cancelUrl(booking) {
  return `${appUrl()}/public/${booking.businessId}/cita/cancelar?bookingId=${booking._id}&token=${encodeURIComponent(booking.publicToken)}`;
}

function bookAgainUrl(booking) {
  return `${appUrl()}/public/${booking.businessId}/cita`;
}

function whenText(date, tz) {
  const d = new Date(date);
  const day = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
  return { day: day.charAt(0).toUpperCase() + day.slice(1), time };
}

function euros(cents) {
  if (!cents) return '';
  return `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;
}

async function staffNames(booking) {
  const ids = [...new Set(booking.segments.flatMap((s) => (s.resourceIds || []).map(String)))];
  if (!ids.length) return '';
  const Resource = require('../models/Resource');
  const rows = await Resource.find({ _id: { $in: ids }, kind: 'staff' }).select('name').lean();
  return rows.map((r) => r.name).join(', ');
}

function button(href, label, color) {
  return `<table cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr><td style="border-radius:10px;background:${color};">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

function detailsTable(rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px 20px;margin-top:16px;">
    <tr><td><table width="100%" cellpadding="0" cellspacing="0">${rows.filter(Boolean).join('')}</table></td></tr>
  </table>`;
}

function contactBlock(business) {
  const parts = [business.phone, business.email].filter(Boolean).map(escapeHtml);
  if (!parts.length) return '';
  return `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;">¿Dudas? Contacta con ${escapeHtml(business.name)}: ${parts.join(' · ')}</p>`;
}

// Legal notice + one-click opt-out (LSSI art. 21.2) for customer emails.
function optOutBlock(business, optOutUrl, { followUp }) {
  if (!optOutUrl) return '';
  const biz = escapeHtml(business.name || '');
  const text = followUp
    ? `Te escribimos porque eres cliente de ${biz}. Si no quieres recibir más avisos como este,`
    : `Como cliente de ${biz}, podemos avisarte de cuándo te toca volver o pedirte tu opinión después de la visita. Si no quieres recibir esos avisos,`;
  return `<p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #f3f4f6;font-size:11px;line-height:1.5;color:#9ca3af;">
    ${text} <a href="${escapeHtml(optOutUrl)}" style="color:#6b7280;text-decoration:underline;">date de baja aquí</a>.
  </p>`;
}

/** Opt-out link for a customer, creating their token the first time. */
async function optOutUrlFor(customerId) {
  if (!customerId) return null;
  const c = await Customer.findById(customerId).select('unsubscribeToken marketingUnsubscribed').lean();
  if (!c || c.marketingUnsubscribed) return null;
  let token = c.unsubscribeToken;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    await Customer.updateOne({ _id: customerId, unsubscribeToken: null }, { $set: { unsubscribeToken: token } });
    token = (await Customer.findById(customerId).select('unsubscribeToken').lean())?.unsubscribeToken || token;
  }
  return `${appUrl()}/public/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function loadBusiness(businessId) {
  return Business.findById(businessId).select('name email phone address brandColor logoUpdatedAt timezone').lean();
}

/**
 * Builds a customer email. `kind`: confirmed | pending | reminder | cancelled.
 * Pure given its inputs (tested with fixed data).
 */
function buildCustomerEmail(kind, { booking, business, staff, optOutUrl = null }) {
  const tz = businessTimezone(business);
  const color = business.brandColor || DEFAULT_ACCENT;
  const { day, time } = whenText(booking.start, tz);
  const services = booking.segments.map((s) => s.serviceName).join(' + ');
  const name = escapeHtml(booking.guestName || '');
  const biz = escapeHtml(business.name || '');

  const copy = {
    confirmed: {
      subject: `Cita confirmada - ${business.name}`,
      title: 'Cita confirmada',
      intro: `Hola ${name}, tu cita en <strong>${biz}</strong> está confirmada.`,
    },
    pending: {
      subject: `Hemos recibido tu solicitud - ${business.name}`,
      title: 'Solicitud recibida',
      intro: `Hola ${name}, hemos recibido tu solicitud de cita en <strong>${biz}</strong>. Te avisaremos cuando la confirmen.`,
    },
    reminder: {
      subject: `Recordatorio: tu cita mañana - ${business.name}`,
      title: 'Recordatorio de cita',
      intro: `Hola ${name}, te recordamos tu cita en <strong>${biz}</strong>.`,
    },
    cancelled: {
      subject: `Cita cancelada - ${business.name}`,
      title: 'Cita cancelada',
      intro: `Hola ${name}, tu cita en <strong>${biz}</strong> ha sido cancelada.`,
    },
  }[kind];

  const rows = [
    detailRow('Servicio', services),
    detailRow('Día', day),
    detailRow('Hora', time),
    staff ? detailRow('Con', staff) : '',
    booking.totalPrice ? detailRow('Precio', euros(booking.totalPrice)) : '',
    business.address ? detailRow('Dirección', business.address) : '',
  ];

  const action = kind === 'cancelled'
    ? button(bookAgainUrl(booking), 'Reservar otra cita', color)
    : `${button(cancelUrl(booking), kind === 'pending' ? 'Ver o cancelar solicitud' : 'Ver o cancelar mi cita', color)}
       <p style="margin:6px 0 0;font-size:12px;color:#9ca3af;">Si no puedes venir, cancela con antelación para que otra persona pueda usar el hueco.</p>`;

  const logo = businessLogoUrl(business);
  const html = baseLayout(color, `
    ${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(business.name)}" style="display:block;max-height:56px;max-width:180px;margin:0 0 18px;border:0;" />` : ''}
    <p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">${copy.intro}</p>
    ${detailsTable(rows)}
    ${action}
    ${contactBlock(business)}
    ${['confirmed', 'pending'].includes(kind) ? optOutBlock(business, optOutUrl, { followUp: false }) : ''}
  `, copy.title);

  return { subject: copy.subject, html };
}

/**
 * Follow-up emails. `kind`: rebook ("te toca volver") | review ("¿qué tal?").
 * Pure given its inputs (tested with fixed data). Always carries the opt-out.
 */
function buildFollowUpEmail(kind, { business, name, service, staff, reviewUrl, bookUrl, optOutUrl }) {
  const color = business.brandColor || DEFAULT_ACCENT;
  const who = escapeHtml(name || '');
  const biz = escapeHtml(business.name || '');
  const logo = businessLogoUrl(business);
  const head = logo ? `<img src="${escapeHtml(logo)}" alt="${biz}" style="display:block;max-height:56px;max-width:180px;margin:0 0 18px;border:0;" />` : '';
  let subject; let title; let body;
  if (kind === 'rebook') {
    subject = `¿Te reservamos tu próxima cita? - ${business.name}`;
    title = '¿Repetimos?';
    body = `<p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">Hola ${who}, ya ha pasado un tiempo desde tu última visita a <strong>${biz}</strong>${service ? ` (${escapeHtml(service)}${staff ? ` con ${escapeHtml(staff)}` : ''})` : ''}.</p>
      <p style="margin:12px 0 0;font-size:15px;color:#111827;line-height:1.6;">Si te apetece repetir, puedes elegir día y hora en un momento:</p>
      ${button(bookUrl, 'Reservar cita', color)}`;
  } else {
    subject = `¿Qué tal tu visita a ${business.name}?`;
    title = '¿Qué tal fue?';
    body = `<p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">Hola ${who}, gracias por venir a <strong>${biz}</strong>.</p>
      <p style="margin:12px 0 0;font-size:15px;color:#111827;line-height:1.6;">Tu opinión nos ayuda muchísimo. ¿Nos cuentas qué tal en Google? Solo es un minuto.</p>
      ${button(reviewUrl, 'Dejar mi opinión', color)}`;
  }
  const html = baseLayout(color, `${head}${body}${contactBlock(business)}${optOutBlock(business, optOutUrl, { followUp: true })}`, title);
  return { subject, html };
}

async function sendFollowUp(kind, { booking, customer, reviewUrl }) {
  try {
    const to = customer?.email || booking.guestEmail;
    if (!emailEnabled() || !to) return false;
    const [business, optOutUrl, staff] = await Promise.all([loadBusiness(booking.businessId), optOutUrlFor(customer?._id), staffNames(booking)]);
    if (!business || !optOutUrl) return false; // no opt-out link, no commercial email
    const { subject, html } = buildFollowUpEmail(kind, {
      business, name: customer?.name || booking.guestName, service: booking.segments.map((s) => s.serviceName).join(' + '),
      staff, reviewUrl, bookUrl: bookAgainUrl(booking), optOutUrl,
    });
    const result = await sendEmail({ from: fromBusiness(business.name), to, replyTo: business.email || undefined, subject, html },
      `booking.followup_${kind}`, { businessId: String(booking.businessId), bookingId: String(booking._id) });
    return !result?.error;
  } catch (err) {
    console.error(`[bookings] ${kind} follow-up email failed:`, err.message);
    return false;
  }
}

/** Email for the business team. `kind`: created | cancelled. */
function buildStaffEmail(kind, { booking, business, staff }) {
  const tz = businessTimezone(business);
  const color = business.brandColor || DEFAULT_ACCENT;
  const { day, time } = whenText(booking.start, tz);
  const services = booking.segments.map((s) => s.serviceName).join(' + ');
  const created = kind === 'created';
  const pending = created && booking.status === 'pending';
  const title = !created ? 'Cita cancelada por el cliente' : pending ? 'Nueva solicitud de cita' : 'Nueva cita online';
  const html = baseLayout(color, `
    <p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">
      ${created ? (pending ? 'Tienes una solicitud de cita pendiente de aprobar.' : 'Un cliente ha reservado desde tu página de reservas.') : 'Un cliente ha cancelado su cita. El hueco vuelve a estar libre.'}
    </p>
    ${detailsTable([
      detailRow('Cliente', booking.guestName || '-'),
      detailRow('Teléfono', booking.guestPhone || '-'),
      detailRow('Email', booking.guestEmail || '-'),
      detailRow('Servicio', services),
      detailRow('Día', day),
      detailRow('Hora', time),
      staff ? detailRow('Con', staff) : '',
      booking.notes ? detailRow('Notas', booking.notes) : '',
    ])}
    ${button(`${appUrl()}/agenda`, 'Abrir agenda', color)}
  `, title);
  return { subject: `${title} - ${booking.guestName || 'Cliente'} · ${day} ${time}`, html };
}

async function staffRecipients(businessId, kind) {
  const members = await BusinessMember.find({
    businessId, status: { $ne: 'invited' }, role: { $in: ['owner', 'manager'] }, userEmail: { $ne: '' },
  }).select('userEmail notificationPreferences').lean();
  return [...new Set(members
    .filter((m) => {
      const prefs = m.notificationPreferences || {};
      return kind === 'cancelled' ? prefs.cancelledReservationEmail !== false : prefs.newReservationEmail !== false;
    })
    .map((m) => m.userEmail)
    .filter(Boolean))];
}

async function sendToCustomer(kind, booking) {
  try {
    if (!emailEnabled() || !booking.guestEmail) return false;
    const business = await loadBusiness(booking.businessId);
    if (!business) return false;
    const staff = await staffNames(booking);
    // Tell customers about the follow-ups (and how to refuse them) when the business uses them
    let optOutUrl = null;
    if (['confirmed', 'pending'].includes(kind) && booking.customerId) {
      const FollowUpSettings = require('../models/FollowUpSettings');
      const fs = await FollowUpSettings.findOne({ businessId: booking.businessId }).lean();
      if (fs?.rebook?.enabled || fs?.review?.enabled) optOutUrl = await optOutUrlFor(booking.customerId);
    }
    const { subject, html } = buildCustomerEmail(kind, { booking, business, staff, optOutUrl });
    const result = await sendEmail({ from: fromBusiness(business.name), to: booking.guestEmail, replyTo: business.email || undefined, subject, html },
      `booking.${kind}`, { businessId: String(booking.businessId), bookingId: String(booking._id) });
    return !result?.error;
  } catch (err) {
    console.error(`[bookings] ${kind} email failed:`, err.message);
    return false;
  }
}

async function sendToStaff(kind, booking) {
  try {
    if (!emailEnabled()) return false;
    const [business, to] = await Promise.all([loadBusiness(booking.businessId), staffRecipients(booking.businessId, kind)]);
    if (!business || !to.length) return false;
    const staff = await staffNames(booking);
    const { subject, html } = buildStaffEmail(kind, { booking, business, staff });
    await sendEmail({ from: fromBusiness('Vetra'), to, replyTo: booking.guestEmail || undefined, subject, html },
      `booking.staff_${kind}`, { businessId: String(booking.businessId), bookingId: String(booking._id) });
    return true;
  } catch (err) {
    console.error(`[bookings] staff ${kind} email failed:`, err.message);
    return false;
  }
}

module.exports = {
  buildCustomerEmail,
  buildStaffEmail,
  buildFollowUpEmail,
  sendFollowUp,
  // Customer
  sendBookingConfirmation: (b) => sendToCustomer(b.status === 'pending' ? 'pending' : 'confirmed', b),
  sendBookingReminder: (b) => sendToCustomer('reminder', b),
  sendBookingCancelled: (b) => sendToCustomer('cancelled', b),
  // Business team
  notifyStaffNewBooking: (b) => sendToStaff('created', b),
  notifyStaffCancelled: (b) => sendToStaff('cancelled', b),
};
