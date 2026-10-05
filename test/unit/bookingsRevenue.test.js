const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { summarize } = load('modules/bookings/services/revenueService');
const NOW = new Date('2026-10-14T18:00:00Z');
const at = (s) => new Date(`${s}:00+02:00`);
const b = (start, status, price, staff, service = 's1') => ({
  status, start: at(start), end: new Date(at(start).getTime() + 3600000), totalPrice: price,
  segments: [{ serviceId: service, price, resourceIds: staff }],
});

test('revenue per day and per professional, with commission', () => {
  const r = summarize({
    tz: 'Europe/Madrid', now: NOW,
    staff: [{ _id: 'ana', name: 'Ana' }, { _id: 'luis', name: 'Luis' }],
    commissionByService: { s1: 10, s2: 0 },
    bookings: [
      b('2026-10-13T10:00', 'completed', 2000, ['ana']),
      b('2026-10-13T11:00', 'confirmed', 3000, ['luis'], 's2'),  // past → attended
      b('2026-10-13T12:00', 'no_show', 5000, ['ana']),           // not counted
      b('2026-10-14T19:30', 'confirmed', 1500, ['ana']),          // later today → not yet
      b('2026-10-14T00:30', 'completed', 1000, ['ana', 'luis']),  // shared
    ],
    payments: [
      { payment: { date: '2026-10-13', total: 4800, tip: 200 } },
    ],
  });
  assert.deepEqual(r.byDate['2026-10-13'], { appointments: 2, billed: 50, collected: 48, tips: 2, payments: 1 });
  assert.equal(r.byDate['2026-10-14'].appointments, 1);
  const ana = r.byStaff.find((x) => x.id === 'ana');
  const luis = r.byStaff.find((x) => x.id === 'luis');
  assert.equal(ana.billed, 25);          // 20 + half of 10
  assert.equal(ana.commission, 2.5);     // 10% of 25
  assert.equal(luis.billed, 35);         // 30 + 5
  assert.equal(luis.commission, 0.5);    // s2 has no commission, s1 half share 5 → 0.5
  assert.equal(r.byStaff[0].id, 'luis', 'sorted by revenue');
});

test('a pack sold counts as collected money on the day of the sale', () => {
  const { summarize } = load('modules/bookings/services/revenueService');
  const out = summarize({
    bookings: [], payments: [], staff: [], commissionByService: {}, tz: 'Europe/Madrid', now: new Date('2026-10-14T10:00:00Z'),
    packSales: [{ payment: { date: '2026-10-14', amount: 25000 } }],
  });
  assert.equal(out.byDate['2026-10-14'].collected, 250);
  assert.equal(out.byDate['2026-10-14'].payments, 1);
  assert.equal(out.byDate['2026-10-14'].billed, 0, 'billed stays tied to the appointments, not to the sale');
});
