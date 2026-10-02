const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { computeTeam, monthsFraction } = load('modules/bookings/lib/team');
const NOW = new Date('2026-10-31T20:00:00Z');
const at = (s) => new Date(`${s}:00+01:00`);
const booking = (start, staff, price, service = 'corte', payment = null, status = 'completed') => ({
  status, start: at(start), end: new Date(at(start).getTime() + 3600000), payment,
  segments: [{ serviceId: service, price, resourceIds: [staff] }],
});
const hours = { rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '14:00' }], overrides: [] };

test('months fraction: a full month is 1', () => {
  assert.equal(Math.round(monthsFraction('2026-10-01', '2026-10-31') * 1000) / 1000, 1);
  assert.equal(Math.round(monthsFraction('2026-10-01', '2026-10-16') * 100) / 100, 0.52);
});

test('salary, commissions, products, tips and what each one leaves', () => {
  const r = computeTeam({
    from: '2026-10-01', to: '2026-10-31', now: NOW,
    staff: [
      { _id: 'ana', name: 'Ana', staffEmployeeId: 'eAna' },
      { _id: 'luis', name: 'Luis', staffEmployeeId: 'eLuis' },
      { _id: 'eva', name: 'Eva', staffEmployeeId: 'eEva' },
    ],
    compensations: {
      eAna: { paymentType: 'monthly_fixed', baseAmount: 1200, commissionPercent: 10, productCommissionPercent: 20 },
      eLuis: { paymentType: 'hourly', baseAmount: 10, commissionPercent: null },
      eEva: { paymentType: 'commission_only', baseAmount: 0, commissionPercent: 40 },
    },
    serviceCommission: { tinte: 15, corte: null },
    businessSchedule: hours,
    resourceSchedules: {},
    payments: { eAna: 500 },
    bookings: [
      booking('2026-10-05T10:00', 'ana', 3000, 'corte', { extras: [{ price: 1000, qty: 2 }], tip: 300 }),
      booking('2026-10-06T10:00', 'ana', 5000, 'tinte'),
      booking('2026-10-06T11:00', 'luis', 2000),
      booking('2026-10-07T11:00', 'eva', 4000),
      booking('2026-10-08T11:00', 'eva', 4000, 'corte', null, 'no_show'),
    ],
  });
  const [ana, luis, eva] = r.staff;
  assert.equal(ana.billed, 80);
  assert.equal(ana.products, 20);
  assert.equal(ana.tips, 3);
  // corte 30 × 10% (her own) + tinte 50 × 15% (service wins) + products 20 × 20%
  assert.equal(ana.commission, 3 + 7.5 + 4);
  assert.equal(ana.salary, 1200);
  assert.equal(ana.leaves, 80 + 20 - 1200 - 14.5);
  assert.equal(ana.toPay, 1200 + 14.5 + 3 - 500);
  // 22 working days × 5 h = 110 h × 10 €
  assert.equal(luis.hours, 110);
  assert.equal(luis.salary, 1100);
  assert.equal(luis.commission, 0);
  assert.equal(eva.appointments, 1, 'no-shows do not count');
  assert.equal(eva.commission, 16);
  assert.equal(eva.salary, 0);
  assert.equal(r.totals.billed, 80 + 20 + 40);
});
