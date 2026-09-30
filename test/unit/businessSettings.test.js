/**
 * Characterization tests for the business settings endpoints in authController:
 * what gets written to MongoDB, what the API returns and which fields the
 * public page can read. Mongoose calls are stubbed, so no database is needed.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const Business = load('models/Business', 'core/models/Business');
const auth = load('controllers/authController', 'core/controllers/authController');

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

const stored = {
  _id: 'biz1', name: 'Rest', email: 'r@example.test', phone: '600', address: 'C/ Mayor 1', cif: 'B1',
  brandColor: '#123456', maxReservationPeople: 12, maxPeoplePerSlot: undefined, reservationDuration: 90,
  minBookingNoticeHours: undefined, requireApprovalAbove: 8, reminderHoursBefore: undefined,
  plan: 'pro', subscriptionStatus: 'active', trialEndsAt: undefined, currentPeriodEnd: undefined,
  cancelAtPeriodEnd: undefined, moduleOverrides: {},
};

describe('business settings endpoints', () => {
  const original = {};
  let captured;
  beforeEach(() => {
    captured = {};
    for (const k of ['findById', 'findOne', 'updateOne']) original[k] = Business[k];
    Business.findById = (id) => ({
      select: (s) => {
        if (s === '-password') return Promise.resolve({ ...stored, ...(captured.update || {}) }); // re-read after an update
        captured.publicSelect = s; captured.publicId = id; return Promise.resolve(null);
      },
    });
    Business.findOne = () => ({ select: () => Promise.resolve(null) });
    Business.updateOne = (filter, update, opts) => {
      captured.filter = filter; captured.update = update; captured.opts = opts;
      return Promise.resolve({ acknowledged: true });
    };
  });
  afterEach(() => { Object.assign(Business, original); });

  test('public page reads exactly these fields', async () => {
    const res = fakeRes();
    await auth.getPublicBusiness({ params: { id: 'biz1' } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(captured.publicSelect,
      'name email phone address brandColor slug businessType maxReservationPeople maxPeoplePerSlot reservationDuration minBookingNoticeHours');
  });

  test('update writes the same fields and normalizations', async () => {
    const res = fakeRes();
    await auth.updateBusinessSettings({
      businessId: 'biz1',
      body: {
        name: '  Nuevo  ', phone: ' 611 ', address: ' Calle ', cif: ' B2 ', brandColor: '#ff0000',
        maxReservationPeople: 10, maxPeoplePerSlot: 30, reservationDuration: 120, requireApprovalAbove: 6,
        minBookingNoticeHours: '', reminderHoursBefore: 48, timezone: 'Europe/Lisbon', email: ' NEW@Example.test ',
        ignored: 'x',
      },
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(captured.update, {
      name: 'Nuevo', phone: '611', address: 'Calle', cif: 'B2', brandColor: '#ff0000',
      maxReservationPeople: 10, maxPeoplePerSlot: 30, reservationDuration: 120, requireApprovalAbove: 6,
      minBookingNoticeHours: 0, reminderHoursBefore: 48, timezone: 'Europe/Lisbon', email: 'new@example.test',
    });
    assert.deepEqual(captured.filter, { _id: 'biz1' });
    assert.deepEqual(captured.opts, { runValidators: true });
  });

  test('minBookingNoticeHours string becomes a number; untouched fields are not written', async () => {
    const res = fakeRes();
    await auth.updateBusinessSettings({ businessId: 'biz1', body: { minBookingNoticeHours: '3' } }, res);
    assert.deepEqual(captured.update, { minBookingNoticeHours: 3 });
  });

  test('invalid timezone is rejected', async () => {
    const res = fakeRes();
    await auth.updateBusinessSettings({ businessId: 'biz1', body: { timezone: 'Nowhere/Land' } }, res);
    assert.equal(res.statusCode, 400);
  });

  test('response payload keeps its shape and defaults', async () => {
    const res = fakeRes();
    await auth.updateBusinessSettings({ businessId: 'biz1', body: {} }, res);
    const b = res.body;
    assert.deepEqual(Object.keys(b), [
      'id', 'name', 'email', 'slug', 'publicUrl', 'phone', 'address', 'cif', 'brandColor', 'logoUrl', 'timezone', 'businessType',
      'maxReservationPeople', 'maxPeoplePerSlot', 'reservationDuration', 'minBookingNoticeHours',
      'requireApprovalAbove', 'reminderHoursBefore',
      'plan', 'subscriptionStatus', 'trialEndsAt', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'capabilities', 'modules',
    ]);
    assert.equal(b.maxReservationPeople, 12);
    assert.equal(b.maxPeoplePerSlot, null);
    assert.equal(b.minBookingNoticeHours, 0);
    assert.equal(b.reminderHoursBefore, 24);
    assert.equal(b.requireApprovalAbove, 8);
    assert.equal(b.cancelAtPeriodEnd, false);
    assert.equal(b.trialEndsAt, null);
  });
});
