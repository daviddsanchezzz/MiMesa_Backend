const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { rebookTarget, reviewDue } = load('modules/bookings/lib/followUps');

const NOW = new Date('2026-10-01T10:00:00Z');
const daysAgo = (n, hour = 10) => new Date(NOW.getTime() - n * 86400000 + (hour - 10) * 3600000);
const visit = (id, n, extra = {}) => {
  const start = daysAgo(n);
  return { _id: id, status: 'completed', start, end: new Date(start.getTime() + 45 * 60000), ...extra };
};

describe('te toca volver', () => {
  test('a customer who came 50 days ago once is due: the last visit is the target', () => {
    const b = [visit('a', 50)];
    assert.equal(rebookTarget(b, NOW)?._id, 'a');
  });

  test('only once per visit', () => {
    assert.equal(rebookTarget([visit('a', 50, { rebookReminderSentAt: daysAgo(3) })], NOW), null);
  });

  test('not if they already have an appointment booked', () => {
    const future = { _id: 'f', status: 'confirmed', start: new Date(NOW.getTime() + 3 * 86400000), end: new Date(NOW.getTime() + 3 * 86400000 + 1800000) };
    assert.equal(rebookTarget([visit('a', 50), future], NOW), null);
  });

  test('not before their usual rhythm (every ~30 days, last 20 days ago)', () => {
    assert.equal(rebookTarget([visit('a', 80), visit('b', 50), visit('c', 20)], NOW), null);
  });

  test('never came for real (only no-shows / never charged nor completed): nothing', () => {
    const b = [{ _id: 'x', status: 'no_show', start: daysAgo(50), end: daysAgo(50) }, { _id: 'y', status: 'confirmed', start: daysAgo(60), end: daysAgo(60) }];
    assert.equal(rebookTarget(b, NOW), null);
  });

  test('lost customers (8+ months) are not chased', () => {
    assert.equal(rebookTarget([visit('a', 300)], NOW), null);
  });
});

describe('pedir reseña', () => {
  const recent = (hoursAgo, extra = {}) => {
    const end = new Date(NOW.getTime() - hoursAgo * 3600000);
    return { _id: 'r', status: 'completed', start: new Date(end.getTime() - 3600000), end, ...extra };
  };

  test('a few hours after an attended visit', () => {
    assert.equal(reviewDue(recent(4), [], NOW, 3), true);
    assert.equal(reviewDue(recent(1), [], NOW, 3), false, 'too soon');
    assert.equal(reviewDue(recent(60), [], NOW, 3), false, 'too old: not after enabling the feature');
  });

  test('charged counts as attended; confirmed without charge does not', () => {
    assert.equal(reviewDue(recent(5, { status: 'confirmed', payment: { total: 1000 } }), [], NOW), true);
    assert.equal(reviewDue(recent(5, { status: 'confirmed' }), [], NOW), false);
    assert.equal(reviewDue(recent(5, { status: 'no_show' }), [], NOW), false);
  });

  test('once per visit, and not again for regulars within the cooldown', () => {
    assert.equal(reviewDue(recent(5, { reviewRequestedAt: NOW }), [], NOW), false);
    assert.equal(reviewDue(recent(5), [{ reviewRequestedAt: daysAgo(30) }], NOW), false);
    assert.equal(reviewDue(recent(5), [{ reviewRequestedAt: daysAgo(200) }], NOW), true);
  });
});
