const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { buildPayment, tillTotals } = load('modules/bookings/lib/checkout');
const booking = { status: 'confirmed', totalPrice: 2200, payment: null };
const opts = { now: new Date('2026-10-14T10:00:00Z'), localDate: '2026-10-14', userId: 'u1' };

test('payment: appointment price, products, discount and tip', () => {
  const p = buildPayment(booking, {
    method: 'card', extras: [{ name: 'Champú', price: 1250, qty: 2 }], discount: 500, tip: 200,
  }, opts);
  assert.equal(p.services, 2200);
  assert.equal(p.total, 2200 + 2500 - 500);
  assert.equal(p.tip, 200);
  assert.equal(p.date, '2026-10-14');
  assert.equal(p.paidBy, 'u1');
});

test('payment: the price can be changed at the till', () => {
  assert.equal(buildPayment(booking, { method: 'cash', services: 1800 }, opts).total, 1800);
});

test('payment: refuses bad input and wrong states', () => {
  assert.throws(() => buildPayment(booking, { method: 'cheque' }, opts), /Elige cómo ha pagado/);
  assert.throws(() => buildPayment(booking, { method: 'cash', discount: 9999 }, opts), /descuento es mayor/);
  assert.throws(() => buildPayment(booking, { method: 'cash', tip: -1 }, opts), /propina/);
  assert.throws(() => buildPayment(booking, { method: 'cash', services: 12.5 }, opts), /importe/);
  assert.throws(() => buildPayment({ ...booking, status: 'cancelled' }, { method: 'cash' }, opts), /no se puede cobrar/);
  assert.throws(() => buildPayment({ ...booking, payment: { total: 1 } }, { method: 'cash' }, opts), /ya está cobrada/);
  assert.throws(() => buildPayment(booking, { method: 'cash', extras: [{ price: 100 }] }, opts), /falta el nombre/);
});

test('till totals by method; tips counted in the drawer, not in revenue', () => {
  const t = tillTotals([
    { method: 'cash', services: 2000, extras: [], discount: 0, tip: 300, total: 2000 },
    { method: 'card', services: 1500, extras: [{ price: 1000, qty: 1 }], discount: 500, tip: 0, total: 2000 },
  ]);
  assert.equal(t.cash, 2300);
  assert.equal(t.card, 2000);
  assert.equal(t.total, 4000);
  assert.equal(t.tips, 300);
  assert.equal(t.extras, 1000);
  assert.equal(t.payments, 2);
});
