/**
 * Emails for appointments (bookings module):
 *  - to the customer: confirmation (or "request received" when the business
 *    must approve), 24h reminder, cancellation — all with the cancel link;
 *    the confirmation also carries an .ics invite and "add to calendar"
 *  - follow-ups (commercial, opt-out in every email): "te toca volver" and
 *    "¿qué tal tu visita?" with the business's Google review link
 *  - to the business team: new online booking and online cancellation
 *
 * Builders are pure (tested with fixed data); senders never throw.
 */
const Business = require('../../../core/models/Business');
const BusinessMember = require('../../../core/models/BusinessMember');
const { escapeHtml: esc } = require('../../../core/lib/escapeHtml');
const { businessTimezone, dateInTimezone } = require('../../../core/lib/timezone');
const { fromBusiness, sendEmail } = require('../../../core/services/emailKit');
const d = require('../../../core/services/emailDesign');
const { businessLogoUrl } = require('../../../core/lib/images');
const Customer = require('../../../core/models/Customer');
const crypto = require('crypto');
const { publicBookingUrl } = require('../../../core/lib/publicUrls');

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

// The business's public page (vetrareserve.com/{slug}); old address if it has no slug yet.
function bookAgainUrl(booking, business) {
  return publicBookingUrl({ _id: booking.businessId, slug: business?.slug, businessType: 'appointments' });
}

function timeText(date, tz) {
  return new Date(date).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
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

function brandFor(business) {
  return d.brandOf(business, { logoUrl: businessLogoUrl(business) });
}

/** What the customer sees about the appointment in every email. */
function appointment(booking, business, staff) {
  const tz = businessTimezone(business);
  const start = timeText(booking.start, tz);
  const end = booking.end ? timeText(booking.end, tz) : '';
  return {
    tz,
    localDate: dateInTimezone(new Date(booking.start), tz),
    services: booking.segments.map((s) => s.serviceName).join(' + '),
    when: end ? `${start} – ${end}` : start,
    start,
    staff,
  };
}

// Legal notice + one-click opt-out (LSSI art. 21.2) for customer emails.
function optOutNote(business, optOutUrl, { followUp }) {
  if (!optOutUrl) return '';
  const biz = esc(business.name || '');
  const text = followUp
    ? `Te escribimos porque eres cliente de ${biz}. Si no quieres recibir más avisos como este,`
    : `Como cliente de ${biz}, podemos avisarte de cuándo te toca volver o pedirte tu opinión después de la visita. Si no quieres recibir esos avisos,`;
  return `${text} <a href="${esc(optOutUrl)}" style="color:#6b7280;text-decoration:underline;">date de baja aquí</a>.`;
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
  return Business.findById(businessId).select('name email phone address brandColor logoUpdatedAt timezone slug').lean();
}

function calendarTitle(booking, business) {
  return `${booking.segments.map((s) => s.serviceName).join(' + ')} · ${business.name}`;
}

/**
 * Builds a customer email. `kind`: confirmed | pending | reminder | cancelled.
 * Pure given its inputs (tested with fixed data).
 */
function buildCustomerEmail(kind, { booking, business, staff, optOutUrl = null }) {
  const brand = brandFor(business);
  const a = appointment(booking, business, staff);
  const name = esc(d.firstName(booking.guestName));
  const biz = esc(business.name || '');
  const hello = name ? `Hola ${name}` : 'Hola';
  const whenLong = d.dateParts(a.localDate).long;
  const addressRow = business.address
    ? { label: 'Dónde', valueHtml: `${esc(business.address)}<br><a href="${esc(d.mapsUrl(business.address))}" target="_blank" style="color:${brand.color};font-weight:600;text-decoration:none;font-size:13px;">Cómo llegar</a>` }
    : null;
  const rows = [
    booking.totalPrice ? { label: 'Precio', value: euros(booking.totalPrice) } : null,
    booking.partySize > 1 ? { label: 'Personas', value: String(booking.partySize) } : null,
    addressRow,
  ];
  const card = d.eventCard({
    localDate: a.localDate, title: a.services, color: brand.color, muted: kind === 'cancelled',
    lines: [`${a.when}${staff ? ` · con ${staff}` : ''}`], rows: kind === 'cancelled' ? [] : rows,
  });
  const calendarUrl = d.googleCalendarUrl({
    title: calendarTitle(booking, business), start: booking.start, end: booking.end || booking.start,
    location: business.address || business.name, details: `Para cambiar o cancelar: ${cancelUrl(booking)}`,
  });
  const cancelLink = `<a href="${esc(cancelUrl(booking))}" target="_blank" style="color:${brand.color};font-weight:600;text-decoration:none;">`;

  const copy = {
    confirmed: {
      subject: `Cita confirmada: ${whenLong} a las ${a.start} · ${business.name}`,
      preheader: `${a.services}${staff ? ` con ${staff}` : ''}. Te esperamos.`,
      title: '¡Cita confirmada!',
      intro: `${hello}, tu cita en <strong>${biz}</strong> está confirmada. Te esperamos.`,
      actions: d.buttons([{ href: calendarUrl, label: 'Añadir al calendario' }, { href: cancelUrl(booking), label: 'Ver o cancelar' }], brand.color),
      after: d.small('¿Te ha surgido algo? Cancela con antelación desde el botón para que otra persona pueda aprovechar el hueco.'),
    },
    pending: {
      subject: `Solicitud recibida: ${whenLong} a las ${a.start} · ${business.name}`,
      preheader: 'Te avisaremos por email en cuanto la confirmen.',
      title: 'Hemos recibido tu solicitud',
      intro: `${hello}, tu solicitud de cita en <strong>${biz}</strong> está pendiente de confirmar.`,
      actions: d.notice(`Te enviaremos otro email en cuanto ${biz} la confirme. Mientras tanto, el hueco queda reservado para ti.`, 'info')
        + d.buttons([{ href: cancelUrl(booking), label: 'Ver o cancelar solicitud', variant: 'secondary' }], brand.color),
      after: '',
    },
    reminder: {
      subject: `Recordatorio: tu cita ${whenLong.toLowerCase()} a las ${a.start} · ${business.name}`,
      preheader: `${a.services}${staff ? ` con ${staff}` : ''} a las ${a.start}.`,
      title: 'Te esperamos pronto',
      intro: `${hello}, te recordamos tu cita en <strong>${biz}</strong>.`,
      actions: d.buttons([
        business.address ? { href: d.mapsUrl(business.address), label: 'Cómo llegar' } : null,
        { href: cancelUrl(booking), label: 'Ver o cancelar', variant: business.address ? 'secondary' : 'primary' },
      ], brand.color),
      after: d.small(`Si no puedes venir, ${cancelLink}cancélala aquí</a> para que otra persona pueda usar el hueco.`),
    },
    cancelled: {
      subject: `Cita cancelada · ${business.name}`,
      preheader: `Tu cita del ${whenLong.toLowerCase()} a las ${a.start} se ha cancelado.`,
      title: 'Cita cancelada',
      intro: `${hello}, tu cita en <strong>${biz}</strong> se ha cancelado.`,
      actions: d.buttons([{ href: bookAgainUrl(booking, business), label: 'Reservar otra cita' }], brand.color),
      after: '',
    },
  }[kind];

  const html = d.layout({
    brand,
    title: copy.title,
    preheader: copy.preheader,
    content: `${d.h1(copy.title)}${d.p(copy.intro)}${card}${copy.actions}${copy.after}`,
    footer: {
      replyHint: true,
      note: ['confirmed', 'pending'].includes(kind) ? optOutNote(business, optOutUrl, { followUp: false }) : '',
    },
  });
  return { subject: copy.subject, html };
}

/** .ics invite for the confirmation email (Apple Calendar, Outlook…). */
function buildInvite(booking, business, staff) {
  const content = d.icsInvite({
    uid: String(booking._id),
    title: calendarTitle(booking, business),
    start: booking.start,
    end: booking.end || booking.start,
    location: business.address || business.name,
    description: `${booking.segments.map((s) => s.serviceName).join(' + ')}${staff ? ` con ${staff}` : ''}\nPara cambiar o cancelar: ${cancelUrl(booking)}`,
    organizerName: business.name,
    stamp: booking.createdAt || null,
  });
  return { filename: 'cita.ics', content: Buffer.from(content).toString('base64'), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' };
}

/**
 * Follow-up emails. `kind`: rebook ("te toca volver") | review ("¿qué tal?").
 * Pure given its inputs (tested with fixed data). Always carries the opt-out.
 */
function buildFollowUpEmail(kind, { business, name, service, staff, reviewUrl, bookUrl, optOutUrl }) {
  const brand = brandFor(business);
  const who = esc(d.firstName(name));
  const hello = who ? `Hola ${who}` : 'Hola';
  const biz = esc(business.name || '');
  let subject; let title; let preheader; let body;
  if (kind === 'rebook') {
    subject = `¿Te reservamos tu próxima cita? · ${business.name}`;
    title = '¿Repetimos?';
    preheader = 'Elige día y hora en un momento.';
    body = `${d.h1(title)}
      ${d.p(`${hello}, ya ha pasado un tiempo desde tu última visita a <strong>${biz}</strong>${service ? ` (${esc(service)}${staff ? ` con ${esc(staff)}` : ''})` : ''}.`)}
      ${d.p('Si te apetece repetir, puedes elegir día y hora en un momento, sin llamar:')}
      ${d.buttons([{ href: bookUrl, label: 'Reservar cita' }], brand.color)}`;
  } else {
    subject = `¿Qué tal tu visita a ${business.name}?`;
    title = '¿Qué tal fue?';
    preheader = 'Tu opinión nos ayuda muchísimo. Solo es un minuto.';
    body = `${d.h1(title)}
      ${d.p(`${hello}, gracias por venir a <strong>${biz}</strong>.`)}
      ${d.p('Tu opinión nos ayuda muchísimo a mejorar y a que nos encuentren otras personas. ¿Nos cuentas qué tal en Google? Solo es un minuto.')}
      ${d.buttons([{ href: reviewUrl, label: 'Dejar mi opinión' }], brand.color)}`;
  }
  const html = d.layout({ brand, title, preheader, content: body, footer: { replyHint: true, note: optOutNote(business, optOutUrl, { followUp: true }) } });
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
      staff, reviewUrl, bookUrl: bookAgainUrl(booking, business), optOutUrl,
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
  const brand = brandFor(business);
  const a = appointment(booking, business, staff);
  const created = kind === 'created';
  const pending = created && booking.status === 'pending';
  const title = !created ? 'Cita cancelada por el cliente' : pending ? 'Nueva solicitud de cita' : 'Nueva cita online';
  const intro = !created ? 'Un cliente ha cancelado su cita. El hueco vuelve a estar libre para reservar.'
    : pending ? 'Tienes una solicitud pendiente de aprobar. El cliente espera tu respuesta.'
      : 'Un cliente ha reservado desde tu página de reservas.';
  const guest = d.details([
    { label: 'Cliente', value: booking.guestName || '-' },
    booking.guestPhone ? { label: 'Teléfono', valueHtml: `<a href="${esc(d.telHref(booking.guestPhone))}" style="color:${brand.color};text-decoration:none;">${esc(booking.guestPhone)}</a>` } : null,
    booking.guestEmail ? { label: 'Email', valueHtml: `<a href="mailto:${esc(booking.guestEmail)}" style="color:${brand.color};text-decoration:none;">${esc(booking.guestEmail)}</a>` } : null,
    booking.notes ? { label: 'Notas', value: booking.notes } : null,
  ]);
  const when = `${d.dateParts(a.localDate).long} ${a.start}`;
  const html = d.layout({
    brand,
    title,
    preheader: `${booking.guestName || 'Cliente'} · ${a.services} · ${when}`,
    content: `${d.h1(title)}${d.p(intro)}
      ${d.eventCard({ localDate: a.localDate, title: a.services, color: brand.color, muted: !created, lines: [`${a.when}${staff ? ` · con ${staff}` : ''}`] })}
      ${d.card(guest)}
      ${d.buttons([{ href: `${appUrl()}/agenda`, label: pending ? 'Revisar solicitud' : 'Abrir agenda' }], brand.color)}`,
    footer: { note: `Recibes este aviso porque gestionas ${esc(business.name || '')} en Vetra. Puedes desactivarlo en tu Perfil.` },
  });
  return { subject: `${title}: ${booking.guestName || 'Cliente'} · ${when}`, html };
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
    const payload = { from: fromBusiness(business.name), to: booking.guestEmail, replyTo: business.email || undefined, subject, html };
    if (kind === 'confirmed') payload.attachments = [buildInvite(booking, business, staff)];
    const result = await sendEmail(payload, `booking.${kind}`, { businessId: String(booking.businessId), bookingId: String(booking._id) });
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
  buildInvite,
  sendFollowUp,
  // Customer
  sendBookingConfirmation: (b) => sendToCustomer(b.status === 'pending' ? 'pending' : 'confirmed', b),
  sendBookingReminder: (b) => sendToCustomer('reminder', b),
  sendBookingCancelled: (b) => sendToCustomer('cancelled', b),
  // Business team
  notifyStaffNewBooking: (b) => sendToStaff('created', b),
  notifyStaffCancelled: (b) => sendToStaff('cancelled', b),
};
