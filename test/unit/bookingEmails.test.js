const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

process.env.FRONTEND_URL = 'https://dev.vetrareserve.com';
const { buildCustomerEmail, buildStaffEmail, buildFollowUpEmail } = load('modules/bookings/services/bookingEmails');

const business = {
  _id: 'biz1', name: 'Peluquería <Laura>', email: 'hola@laura.test', phone: '+34 600 111 222',
  address: 'Carrer Major 12, Mataró', brandColor: '#db2777', timezone: 'Europe/Madrid',
};
const booking = {
  _id: 'bk1', businessId: 'biz1', publicToken: 'tok_abc/+=', status: 'confirmed',
  guestName: 'Marta <script>', guestEmail: 'marta@example.test', guestPhone: '611222333',
  start: new Date('2026-10-13T17:00:00Z'), // 19:00 in Madrid (summer time)
  totalPrice: 2200, notes: 'Pelo largo',
  segments: [{ serviceName: 'Corte mujer' }, { serviceName: 'Peinado' }],
};

describe('appointment emails', () => {
  test('confirmation: local time, services, price, cancel link, escaped text', () => {
    const { subject, html } = buildCustomerEmail('confirmed', { booking, business, staff: 'Ana' });
    assert.equal(subject, 'Cita confirmada: Martes, 13 de octubre a las 19:00 · Peluquería <Laura>');
    assert.match(html, /Martes, 13 de octubre/);
    assert.match(html, /19:00/);
    assert.match(html, /Corte mujer \+ Peinado/);
    assert.match(html, /22 €/);
    assert.match(html, /· con Ana/);
    assert.match(html, /Hola Marta,/, 'first name only');
    assert.ok(html.includes('calendar.google.com/calendar/render'), 'add to calendar');
    assert.ok(html.includes('https://dev.vetrareserve.com/public/biz1/cita/cancelar?bookingId=bk1&amp;token=tok_abc%2F%2B%3D'));
    assert.ok(!html.includes('<script>'), 'guest name is escaped');
    assert.ok(html.includes('Peluquería &lt;Laura&gt;'));
    assert.match(html, /Cita confirmada/);
    assert.ok(html.includes('#db2777'), 'uses brand colour');
  });

  test('shows the business logo when there is one', () => {
    process.env.BACKEND_URL = 'https://api-dev.vetrareserve.com';
    const withLogo = { ...business, logoUpdatedAt: new Date('2026-09-30T10:00:00Z') };
    const { html } = buildCustomerEmail('confirmed', { booking, business: withLogo });
    assert.ok(html.includes('src="https://api-dev.vetrareserve.com/api/auth/public/business/biz1/logo?v=1790762400000"'));
    assert.ok(!buildCustomerEmail('confirmed', { booking, business }).html.includes('<img'));
  });

  test('pending, reminder and cancelled wording', () => {
    assert.match(buildCustomerEmail('pending', { booking, business }).html, /Te enviaremos otro email en cuanto/);
    const reminder = buildCustomerEmail('reminder', { booking, business });
    assert.equal(reminder.subject, 'Recordatorio: tu cita martes, 13 de octubre a las 19:00 · Peluquería <Laura>');
    assert.match(reminder.html, /Ver o cancelar/);
    assert.match(reminder.html, /Cómo llegar/);
    const cancelled = buildCustomerEmail('cancelled', { booking, business });
    assert.match(cancelled.html, /Reservar otra cita/);
    assert.ok(cancelled.html.includes('/public/biz1/cita"'), 'links to book again, not to cancel');
  });

  test('staff email has customer contact and a link to the agenda', () => {
    const { subject, html } = buildStaffEmail('created', { booking, business, staff: 'Ana' });
    assert.match(subject, /^Nueva cita online: Marta/);
    assert.match(html, /611222333/);
    assert.match(html, /marta@example\.test/);
    assert.match(html, /Pelo largo/);
    assert.ok(html.includes('https://dev.vetrareserve.com/agenda'));
    assert.match(buildStaffEmail('created', { booking: { ...booking, status: 'pending' }, business }).subject, /^Nueva solicitud de cita/);
    assert.match(buildStaffEmail('cancelled', { booking, business }).html, /El hueco vuelve a estar libre/);
  });

  test('confirmation mentions follow-ups and the opt-out only when the business uses them', () => {
    const optOutUrl = 'https://dev.vetrareserve.com/public/unsubscribe?token=t1';
    assert.ok(!buildCustomerEmail('confirmed', { booking, business }).html.includes('date de baja'));
    const { html } = buildCustomerEmail('confirmed', { booking, business, optOutUrl });
    assert.match(html, /cuándo te toca volver o pedirte tu opinión/);
    assert.ok(html.includes(optOutUrl));
    assert.ok(!buildCustomerEmail('reminder', { booking, business, optOutUrl }).html.includes('date de baja'), 'reminders are service emails');
  });

  test('follow-ups: rebook and review, always with the opt-out, no incentive', () => {
    const common = { business, name: 'Marta <b>', service: 'Corte mujer', staff: 'Ana', bookUrl: 'https://dev.vetrareserve.com/public/biz1/cita', optOutUrl: 'https://x.test/u?token=1' };
    const rebook = buildFollowUpEmail('rebook', common);
    assert.match(rebook.subject, /próxima cita/);
    assert.match(rebook.html, /Corte mujer con Ana/);
    assert.ok(rebook.html.includes('https://dev.vetrareserve.com/public/biz1/cita'));
    assert.ok(rebook.html.includes('Hola Marta,') && !rebook.html.includes('<b>'), 'first name, escaped');
    assert.match(rebook.html, /date de baja aquí/);
    const review = buildFollowUpEmail('review', { ...common, reviewUrl: 'https://g.page/r/abc/review' });
    assert.ok(review.html.includes('https://g.page/r/abc/review'));
    assert.match(review.html, /date de baja aquí/);
    assert.doesNotMatch(review.html, /descuento|regalo|gratis|sorteo/i, 'Google forbids incentives');
  });

  test('confirmation carries a calendar invite for Apple/Outlook', () => {
    const { buildInvite } = load('modules/bookings/services/bookingEmails');
    const invite = buildInvite({ ...booking, end: new Date('2026-10-13T18:15:00Z') }, business, 'Ana');
    const ics = Buffer.from(invite.content, 'base64').toString();
    assert.equal(invite.filename, 'cita.ics');
    assert.match(ics, /BEGIN:VEVENT/);
    assert.match(ics, /DTSTART:20261013T170000Z/);
    assert.match(ics, /DTEND:20261013T181500Z/);
    assert.match(ics, /SUMMARY:Corte mujer \+ Peinado · Peluquería <Laura>/);
    assert.match(ics, /LOCATION:Carrer Major 12\\, Mataró/);
  });

  test('plain-text version keeps the words and the links', () => {
    const { htmlToText } = load('core/services/emailDesign');
    const text = htmlToText(buildCustomerEmail('confirmed', { booking, business, staff: 'Ana' }).html);
    assert.match(text, /¡Cita confirmada!/);
    assert.match(text, /Corte mujer \+ Peinado/);
    assert.match(text, /Ver o cancelar: https:\/\/dev\.vetrareserve\.com\/public\/biz1\/cita\/cancelar/);
    assert.ok(!/<(table|td|tr|a|p|h1|div|span|img)\b/i.test(text), 'no tags left');
    assert.equal(text.split('¡Cita confirmada!').length - 1, 1, 'title once');
  });
});
