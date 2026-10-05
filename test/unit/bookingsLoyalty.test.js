const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { progress, discountFor, settingsInput, shape } = load('modules/bookings/lib/loyalty');

const on = { enabled: true, every: 10, reward: { type: 'percent', value: 10 } };

describe('loyalty progress', () => {
  test('the Nth paid visit earns the reward', () => {
    assert.equal(progress(on, 0).rewardDue, false);
    assert.equal(progress(on, 8).rewardDue, false);
    assert.equal(progress(on, 9).rewardDue, true, 'the 10th visit');
    assert.equal(progress(on, 10).rewardDue, false);
    assert.equal(progress(on, 19).rewardDue, true, 'and every 10 after that');
  });
  test('how many visits are left', () => {
    assert.equal(progress(on, 0).toNext, 10);
    assert.equal(progress(on, 7).toNext, 3);
    assert.equal(progress(on, 9).toNext, 1);
    assert.equal(progress(on, 10).toNext, 10);
  });
  test('nothing is due while the programme is off', () => {
    assert.equal(progress({ ...on, enabled: false }, 9).rewardDue, false);
    assert.equal(progress(undefined, 9).enabled, false);
  });
});

describe('discountFor', () => {
  test('a percentage of the ticket, or a fixed amount that never exceeds it', () => {
    assert.equal(discountFor({ type: 'percent', value: 10 }, 2500), 250);
    assert.equal(discountFor({ type: 'amount', value: 500 }, 2500), 500);
    assert.equal(discountFor({ type: 'amount', value: 5000 }, 2500), 2500);
    assert.equal(discountFor({ type: 'percent', value: 100 }, 0), 0);
  });
});

describe('settingsInput', () => {
  test('accepts a valid rule and rejects nonsense', () => {
    assert.deepEqual(settingsInput({ enabled: true, every: 8, reward: { type: 'amount', value: 1000 } }), { enabled: true, every: 8, reward: { type: 'amount', value: 1000 } });
    assert.throws(() => settingsInput({ enabled: true, every: 1, reward: { type: 'percent', value: 10 } }), /entre 2 y 100/);
    assert.throws(() => settingsInput({ enabled: true, every: 10, reward: { type: 'percent', value: 150 } }), /100 %/);
    assert.throws(() => settingsInput({ enabled: true, every: 10, reward: { type: 'gift', value: 1 } }), /tipo de premio/);
    assert.throws(() => settingsInput({ every: 10, reward: { type: 'percent', value: 10 } }), /válido/);
  });
  test('defaults when nothing is saved', () => {
    assert.deepEqual(shape(null), { enabled: false, every: 10, reward: { type: 'percent', value: 10 } });
  });
});
