const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { computeInsights, previousPeriod } = load('modules/bookings/lib/insights');

const TZ = 'Europe/Madrid';
// Wednesday 14 Oct 2026, 12:00 in Madrid (UTC+2)
const NOW = new Date('2026-10-14T10:00:00Z');
const at = (s) => new Date(`${s.replace(' ', 'T')}:00+02:00`);

let n = 0;
function booking({ start, min = 60, status = 'confirmed', price = 2000, who = 'ana', service = ['corte', 'Corte'], source = 'staff' }) {
  const s = at(start);
  n += 1;
  return {
    _id: `b${n}`, guestName: who, guestEmail: `${who}@test`, guestPhone: '', customerId: null, status, source,
    start: s, end: new Date(s.getTime() + min * 60000), totalPrice: price,
    segments: [{ serviceId: service[0], serviceName: service[1], price }],
  };
}
const run = (bookings, extra = {}) => computeInsights({ now: NOW, timezone: TZ, from: '2026-10-01', to: '2026-10-13', bookings, ...extra });

describe('previousPeriod', () => {
  test('is the same length, right before', () => {
    assert.deepEqual(previousPeriod('2026-10-01', '2026-10-31'), { from: '2026-08-31', to: '2026-09-30' });
    assert.deepEqual(previousPeriod('2026-10-05', '2026-10-11'), { from: '2026-09-28', to: '2026-10-04' });
  });
});

describe('computeInsights', () => {
  test('counts attended appointments and what they billed', () => {
    const r = run([
      booking({ start: '2026-10-02 10:00', price: 3000 }),
      booking({ start: '2026-10-03 11:00', price: 1000, who: 'luis' }),
      booking({ start: '2026-10-04 11:00', price: 5000, status: 'cancelled' }),
      booking({ start: '2026-10-20 11:00', price: 9000 }), // outside the range
    ]);
    assert.equal(r.summary.appointments, 2);
    assert.equal(r.summary.billed, 4000);
    assert.equal(r.summary.averageTicket, 2000);
  });

  test('ranks services by revenue with their share', () => {
    const r = run([
      booking({ start: '2026-10-02 10:00', price: 6000, service: ['tinte', 'Tinte'] }),
      booking({ start: '2026-10-03 10:00', price: 2000 }),
      booking({ start: '2026-10-05 10:00', price: 2000, who: 'luis' }),
    ]);
    assert.deepEqual(r.services.map((s) => [s.name, s.count, s.revenue, s.share]), [['Tinte', 1, 6000, 60], ['Corte', 2, 4000, 40]]);
  });

  test('busy weekdays and hours use the business timezone, Monday first', () => {
    const r = run([
      booking({ start: '2026-10-05 10:00' }), // Monday
      booking({ start: '2026-10-05 10:30', who: 'b' }),
      booking({ start: '2026-10-09 23:30', who: 'c' }), // Friday late
    ]);
    assert.equal(r.byWeekday[0].appointments, 2);
    assert.equal(r.byWeekday[4].appointments, 1);
    assert.deepEqual(r.byHour, [{ hour: 10, appointments: 2 }, { hour: 23, appointments: 1 }]);
  });

  test('separates new from returning customers', () => {
    const r = run([
      booking({ start: '2026-08-10 10:00', who: 'vieja' }), // before the period: she is returning
      booking({ start: '2026-10-02 10:00', who: 'vieja' }),
      booking({ start: '2026-10-03 10:00', who: 'nueva' }),
    ]);
    assert.equal(r.customers.total, 2);
    assert.equal(r.customers.new, 1);
    assert.equal(r.customers.returning, 1);
  });

  test('cancellation and no-show rates over what was scheduled (pending excluded)', () => {
    const r = run([
      booking({ start: '2026-10-02 10:00' }),
      booking({ start: '2026-10-03 10:00', status: 'cancelled', who: 'b' }),
      booking({ start: '2026-10-04 10:00', status: 'no_show', who: 'c' }),
      booking({ start: '2026-10-05 10:00', who: 'd' }),
      booking({ start: '2026-10-06 10:00', status: 'pending', who: 'e' }),
    ]);
    assert.equal(r.cancellations.scheduled, 4);
    assert.equal(r.cancellations.cancelledRate, 25);
    assert.equal(r.cancellations.noShowRate, 25);
  });

  test('splits appointments by source and ignores cancelled ones', () => {
    const r = run([
      booking({ start: '2026-10-02 10:00', source: 'online' }),
      booking({ start: '2026-10-03 10:00', source: 'online', who: 'b' }),
      booking({ start: '2026-10-04 10:00', source: 'phone', who: 'c', status: 'cancelled' }),
    ]);
    assert.equal(r.sources.find((s) => s.key === 'online').appointments, 2);
    assert.equal(r.sources.find((s) => s.key === 'phone').appointments, 0);
  });

  test('compares with the previous period and finds customers overdue for a visit', () => {
    const r = run([
      booking({ start: '2026-09-25 10:00', price: 1000 }), // previous period (18-30 Sep)
      booking({ start: '2026-10-02 10:00', price: 3000, who: 'b' }),
      booking({ start: '2026-07-01 10:00', who: 'ausente' }), // last seen 3+ months ago
    ]);
    assert.equal(r.previous.billed, 1000);
    assert.equal(r.summary.billed, 3000);
    assert.equal(r.customers.lapsed.top[0].name, 'ausente');
  });

  test('compares with the period the caller asks for', () => {
    const r = run([booking({ start: '2026-09-02 10:00', price: 700 })], { compare: { from: '2026-09-01', to: '2026-09-30' } });
    assert.equal(r.previous.billed, 700);
    assert.deepEqual(r.previousRange, { from: '2026-09-01', to: '2026-09-30' });
  });

  test('is empty without bookings', () => {
    const r = run([]);
    assert.equal(r.summary.appointments, 0);
    assert.deepEqual(r.services, []);
    assert.equal(r.cancellations.cancelledRate, 0);
  });
});
