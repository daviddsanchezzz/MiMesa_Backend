const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { tillByDay } = load('modules/bookings/lib/checkout');

const pay = (date, method, total, extra = {}) => ({ date, method, total, tip: 0, services: total, extras: [], discount: 0, ...extra });

describe('till over a period', () => {
  test('adds up by method and keeps one line per day, oldest first', () => {
    const r = tillByDay(
      [pay('2026-10-03', 'card', 3000), pay('2026-10-01', 'cash', 15400, { tip: 100 }), pay('2026-10-03', 'cash', 2000)],
      [{ date: '2026-10-02', method: 'bizum', amount: 25000 }],
    );
    assert.deepEqual(r.days.map((d) => d.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.equal(r.totals.cash, 15400 + 100 + 2000);
    assert.equal(r.totals.card, 3000);
    assert.equal(r.totals.bizum, 25000);
    assert.equal(r.days[0].total, 15500, 'tips are money in the till');
    assert.equal(r.days[1].packSales, 25000);
    assert.equal(r.days[2].payments, 2);
  });
  test('a session spent from a pack is not money', () => {
    const r = tillByDay([pay('2026-10-01', 'pack', 0, { packUse: { name: 'Bono' } })]);
    assert.equal(r.days[0].total, 0);
    assert.equal(r.totals.packSessions, 1);
  });
  test('an empty period', () => {
    const r = tillByDay([], []);
    assert.deepEqual(r.days, []);
    assert.equal(r.totals.total, 0);
  });
});
