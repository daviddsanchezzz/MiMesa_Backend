const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { computeStats, customerKey } = load('modules/bookings/lib/stats');

const TZ = 'Europe/Madrid';
// Wednesday 14 Oct 2026, 12:00 in Madrid (UTC+2)
const NOW = new Date('2026-10-14T10:00:00Z');

const hours = {
  rules: [
    { days: [1, 2, 3, 4, 5], start: '09:00', end: '14:00' },
    { days: [1, 2, 3, 4, 5], start: '16:00', end: '20:00' },
  ],
  overrides: [],
};
const ana = { _id: 'ana', name: 'Ana', color: '#db2777' };
const luis = { _id: 'luis', name: 'Luis' };

let n = 0;
// Madrid local 'YYYY-MM-DD HH:MM' in October / summer time → UTC
const at = (s) => new Date(`${s.replace(' ', 'T')}:00+02:00`);
function booking({ who, start, min = 60, status = 'confirmed', price = 2000, guest = 'Cliente', email, source = 'staff', ...rest }) {
  const s = at(start);
  const e = new Date(s.getTime() + min * 60000);
  n += 1;
  return {
    _id: `b${n}`, guestName: guest, guestEmail: email || `${guest.toLowerCase()}@test`, guestPhone: '',
    status, start: s, end: e, source, totalPrice: price, reminderSentAt: null, cancelledAt: null,
    segments: [{ serviceId: 'corte', serviceName: 'Corte', start: s, end: e, resourceIds: [who], price }],
    ...rest,
  };
}

const bookings = [
  booking({ who: 'ana', start: '2026-10-14 10:00', price: 3000, guest: 'Marta', reminderSentAt: at('2026-10-13 10:00') }),
  booking({ who: 'ana', start: '2026-10-14 13:00', price: 2500, guest: 'Julia' }),
  booking({ who: 'luis', start: '2026-10-14 17:00', min: 45, status: 'pending', price: 2000, guest: 'Online', source: 'online' }),
  booking({ who: 'luis', start: '2026-10-15 09:30', price: 1500, guest: 'Tomorrow' }),
  booking({ who: 'ana', start: '2026-10-05 11:00', status: 'no_show', price: 4000, guest: 'Ghost' }),
  booking({ who: 'ana', start: '2026-10-06 11:00', status: 'cancelled', price: 2000, guest: 'Early', cancelledAt: at('2026-10-03 09:00') }),
  booking({ who: 'luis', start: '2026-10-02 10:00', status: 'completed', price: 5000, guest: 'Nueva' }),
  // Regular every ~31 days, last visit 43 days ago → due back
  booking({ who: 'ana', start: '2026-07-01 10:00', guest: 'Rosa' }),
  booking({ who: 'ana', start: '2026-08-01 10:00', guest: 'Rosa' }),
  booking({ who: 'ana', start: '2026-09-01 10:00', guest: 'Rosa' }),
  // One visit 24 days ago → not due yet
  booking({ who: 'luis', start: '2026-09-20 10:00', guest: 'Pepe' }),
  // Marta came before: she is a returning customer
  booking({ who: 'ana', start: '2026-09-10 10:00', guest: 'Marta', price: 1000 }),
];

const stats = computeStats({ now: NOW, timezone: TZ, staff: [ana, luis], businessSchedule: hours, resourceSchedules: {}, bookings });

describe('dashboard stats', () => {
  test('today and tomorrow', () => {
    assert.deepEqual(stats.today, {
      date: '2026-10-14', appointments: 3, attended: 1, remaining: 2, pending: 1, expectedRevenue: 7500,
    });
    assert.equal(stats.tomorrow.appointments, 1);
    assert.equal(stats.tomorrow.expectedRevenue, 1500);
    assert.equal(new Date(stats.tomorrow.firstStart).toISOString(), at('2026-10-15 09:30').toISOString());
  });

  test('free gaps left today, from now on', () => {
    const gaps = stats.actions.freeGapsToday.map((g) => `${g.name} ${g.startMin / 60}-${g.endMin / 60}`);
    assert.deepEqual(gaps, ['Ana 12-13', 'Luis 12-14', 'Ana 16-20', 'Luis 16-17']);
  });

  test('pending requests and customers due back', () => {
    assert.equal(stats.actions.pendingRequests.count, 1);
    assert.equal(stats.actions.pendingRequests.next.name, 'Online');
    assert.deepEqual(stats.actions.overdueCustomers.top.map((c) => c.name), ['Rosa']);
    assert.equal(stats.actions.overdueCustomers.top[0].daysSince, 43);
  });

  test('money this month and the same days last month', () => {
    const m = stats.money;
    assert.equal(m.monthStart, '2026-10-01');
    assert.equal(m.revenue, 3000 + 5000);            // attended so far
    assert.equal(m.previousRevenue, 2000 + 1000);     // 1–14 September
    assert.deepEqual(m.remindedAttended, { count: 1, amount: 3000 });
    assert.deepEqual(m.onlineBookings, { count: 1, amount: 2000 });
    assert.deepEqual(m.noShows, { count: 1, amount: 4000 });
    assert.equal(m.cancellations.count, 1);
    assert.equal(m.cancelledInTime.count, 1);
  });

  test('team, services and customers', () => {
    const [a, l] = stats.team;
    assert.equal(a.name, 'Ana');
    assert.equal(a.color, '#db2777');
    assert.equal(a.appointments, 1);
    assert.equal(a.revenue, 3000);
    assert.equal(l.revenue, 5000);
    assert.ok(a.weekOccupancy > 0 && a.weekOccupancy < 100);
    assert.equal(stats.topServices[0].name, 'Corte');
    assert.equal(stats.topServices[0].share, 100);
    // Live so far this month: Marta (came in September), Julia, Online, Nueva.
    // Ghost (no-show) and Early (cancelled) don't count; Tomorrow is not yet.
    assert.equal(stats.customers.month, 4);
    assert.equal(stats.customers.returning, 1);
    assert.equal(stats.customers.new, 3);
    assert.equal(stats.customers.onlineShare, 25);
  });

  test('week occupancy counts booked minutes over open minutes', () => {
    // 7 days from Wed: Wed, Thu, Fri, Mon, Tue open (5 days × 9h × 2 staff = 5400 min)
    // booked: Ana 10-11, 13-14; Luis 17:00-17:45 (pending), Thu 9:30-10:30 → 225 min
    assert.equal(stats.week.occupancy, Math.round((225 / 5400) * 100));
    assert.equal(stats.week.freeHours, Math.round((5400 - 225) / 60));
    assert.equal(stats.week.appointments, 4);
  });

  test('customer key prefers the customer record, then email, phone, name', () => {
    assert.equal(customerKey({ customerId: 'c1', guestEmail: 'a@b' }), 'c:c1');
    assert.equal(customerKey({ guestEmail: 'A@B' }), 'e:a@b');
    assert.equal(customerKey({ guestPhone: '+34 600 111 222' }), 'p:600111222');
  });
});
