const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { rhythm, summarizeCustomer } = load('modules/bookings/lib/customers');
const NOW = new Date('2026-10-14T10:00:00Z');
const d = (s) => new Date(`${s}T10:00:00Z`);
const b = (start, status = 'confirmed', price = 2000, service = 'Corte', staff = 'ana') => ({
  _id: start, status, start: d(start), end: new Date(d(start).getTime() + 3600000), totalPrice: price,
  segments: [{ serviceName: service, resourceIds: [staff] }],
});

test('rhythm: average gap and due back', () => {
  const r = rhythm([d('2026-07-01'), d('2026-08-01'), d('2026-09-01')], NOW);
  assert.equal(r.visits, 3);
  assert.equal(r.avgDays, 31);
  assert.equal(r.daysSince, 43);
  assert.equal(r.dueBack, true);
  assert.equal(rhythm([d('2026-09-20')], NOW).dueBack, false, 'one visit 24 days ago is not due yet');
  assert.equal(rhythm([d('2025-09-20')], NOW).dueBack, false, 'a year ago: lost, not due');
  assert.equal(rhythm([], NOW).visits, 0);
});

test('customer summary: spend, next visit, no-shows, favourites', () => {
  const s = summarizeCustomer([
    b('2026-07-01', 'completed', 2200, 'Tinte', 'maria'),
    b('2026-08-01', 'confirmed', 2200, 'Tinte', 'maria'),
    b('2026-09-01', 'no_show', 2200),
    b('2026-09-05', 'cancelled', 2200),
    b('2026-10-20', 'confirmed', 1500),
  ], NOW);
  assert.equal(s.visits, 2);
  assert.equal(s.spent, 4400);
  assert.equal(s.noShows, 1);
  assert.equal(s.cancellations, 1);
  assert.equal(new Date(s.nextVisit).toISOString(), d('2026-10-20').toISOString());
  assert.equal(s.dueBack, false, 'has a next appointment');
  assert.equal(s.favouriteService, 'Tinte');
  assert.equal(s.favouriteStaffId, 'maria');
});
