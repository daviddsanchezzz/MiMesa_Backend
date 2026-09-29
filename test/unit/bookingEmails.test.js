const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

process.env.FRONTEND_URL = 'https://dev.vetrareserve.com';
const { buildCustomerEmail, buildStaffEmail } = load('modules/bookings/services/bookingEmails');

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
    assert.equal(subject, 'Cita confirmada - Peluquería <Laura>');
    assert.match(html, /Martes, 13 de octubre/);
    assert.match(html, /19:00/);
    assert.match(html, /Corte mujer \+ Peinado/);
    assert.match(html, /22 €/);
    assert.match(html, />Ana</);
    assert.ok(html.includes('https://dev.vetrareserve.com/public/biz1/cita/cancelar?bookingId=bk1&amp;token=tok_abc%2F%2B%3D'));
    assert.ok(!html.includes('<script>'), 'guest name is escaped');
    assert.ok(html.includes('Peluquería &lt;Laura&gt;'));
    assert.match(html, /Cita confirmada/);
    assert.ok(html.includes('#db2777'), 'uses brand colour');
  });

  test('pending, reminder and cancelled wording', () => {
    assert.match(buildCustomerEmail('pending', { booking, business }).html, /Te avisaremos cuando la confirmen/);
    const reminder = buildCustomerEmail('reminder', { booking, business });
    assert.equal(reminder.subject, 'Recordatorio: tu cita mañana - Peluquería <Laura>');
    assert.match(reminder.html, /Ver o cancelar mi cita/);
    const cancelled = buildCustomerEmail('cancelled', { booking, business });
    assert.match(cancelled.html, /Reservar otra cita/);
    assert.ok(cancelled.html.includes('/public/biz1/cita"'), 'links to book again, not to cancel');
  });

  test('staff email has customer contact and a link to the agenda', () => {
    const { subject, html } = buildStaffEmail('created', { booking, business, staff: 'Ana' });
    assert.match(subject, /^Nueva cita online - Marta/);
    assert.match(html, /611222333/);
    assert.match(html, /marta@example\.test/);
    assert.match(html, /Pelo largo/);
    assert.ok(html.includes('https://dev.vetrareserve.com/agenda'));
    assert.match(buildStaffEmail('created', { booking: { ...booking, status: 'pending' }, business }).subject, /^Nueva solicitud de cita/);
    assert.match(buildStaffEmail('cancelled', { booking, business }).html, /El hueco vuelve a estar libre/);
  });
});
