const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { computeSegment } = load('modules/bookings/lib/segments');

const NOW = new Date('2026-10-14T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY);

let n = 0;
function visit(customerId, daysAgo, serviceId = 'corte', status = 'confirmed') {
  n += 1;
  const start = daysAgo >= 0 ? ago(daysAgo) : new Date(NOW.getTime() + -daysAgo * DAY);
  return { _id: `b${n}`, customerId, status, start, end: new Date(start.getTime() + 3600000), segments: [{ serviceId }] };
}
const customer = (id, extra = {}) => ({ _id: id, name: `Cliente ${id}`, email: `${id}@test`, birthday: '', marketingSubscribed: true, marketingUnsubscribed: false, ...extra });

describe('computeSegment', () => {
  test('only reaches customers who agreed to emails and have one', () => {
    const r = computeSegment({
      type: 'all', now: NOW, bookings: [],
      customers: [customer('a'), customer('b', { marketingSubscribed: false }), customer('c', { marketingUnsubscribed: true }), customer('d', { email: '' })],
    });
    assert.equal(r.total, 4);
    assert.equal(r.reachable, 1);
    assert.deepEqual(r.customerIds, ['a']);
  });

  test('service: customers who had that service', () => {
    const r = computeSegment({
      type: 'service', params: { serviceId: 'laser' }, now: NOW,
      customers: [customer('a'), customer('b')],
      bookings: [visit('a', 20, 'laser'), visit('b', 20, 'corte')],
    });
    assert.deepEqual(r.customerIds, ['a']);
  });

  test('lapsed: last visit long ago and nothing booked', () => {
    const r = computeSegment({
      type: 'lapsed', params: { days: 90 }, now: NOW,
      customers: [customer('a'), customer('b'), customer('c'), customer('d')],
      bookings: [visit('a', 120), visit('b', 30), visit('c', 200), visit('c', -5), visit('d', 100, 'x', 'cancelled')],
    });
    assert.deepEqual(r.customerIds, ['a']); // b came recently, c has an appointment coming, d never came
  });

  test('new: first visit within the last days', () => {
    const r = computeSegment({
      type: 'new', params: { days: 30 }, now: NOW,
      customers: [customer('a'), customer('b')],
      bookings: [visit('a', 10), visit('b', 80), visit('b', 5)],
    });
    assert.deepEqual(r.customerIds, ['a']);
  });

  test('frequent: at least N attended visits', () => {
    const r = computeSegment({
      type: 'frequent', params: { visits: 3 }, now: NOW,
      customers: [customer('a'), customer('b')],
      bookings: [visit('a', 10), visit('a', 20), visit('a', 30), visit('b', 10), visit('b', 20)],
    });
    assert.deepEqual(r.customerIds, ['a']);
  });

  test('birthday: this month by default', () => {
    const r = computeSegment({
      type: 'birthday', now: NOW,
      customers: [customer('a', { birthday: '10-27' }), customer('b', { birthday: '03-02' }), customer('c')],
      bookings: [],
    });
    assert.deepEqual(r.customerIds, ['a']);
  });

  test('rejects an unknown segment', () => {
    assert.throws(() => computeSegment({ type: 'whatever', customers: [], bookings: [] }));
  });
});
