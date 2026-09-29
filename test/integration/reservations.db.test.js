/**
 * End-to-end tests against a real MongoDB. They are skipped unless
 * MONGO_TEST_URI points to a disposable database, e.g.:
 *
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017" npm test
 *
 * Each run creates its own database (vetra_test_<timestamp>) and drops it
 * at the end, so it never touches real data. Never point it at production.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

const MODEL_DIRS = ['models', 'core/models', 'modules/staff/models', 'modules/finance/models', 'verticals/restaurant/models'];
function model(name) {
  for (const dir of MODEL_DIRS) {
    try { return require(require.resolve(path.join(ROOT, dir, name))); } catch { /* next */ }
  }
  throw new Error(`model ${name} not found`);
}

function futureDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

describe('reservations with a real database', { skip }, () => {
  let app, mongoose, Business, BusinessMember, Shift, Reservation, Customer;
  let bizA, bizB;
  const date = futureDate(30);

  before(async () => {
    installFakeAuth();
    // Never call Resend from tests.
    const delivery = ['services/emailDelivery', 'core/services/emailDelivery']
      .map((p) => { try { return require.resolve(path.join(ROOT, p)); } catch { return null; } }).find(Boolean);
    require(delivery);
    require.cache[delivery].exports.sendTrackedEmail = async () => ({ data: { id: 'test' } });

    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_test_${Date.now()}` });

    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;

    Business = model('Business');
    BusinessMember = model('BusinessMember');
    Shift = model('Shift');
    Reservation = model('Reservation');
    Customer = model('Customer');

    bizA = await Business.create({ name: 'Rest A', email: 'a@example.test', plan: 'pro', subscriptionStatus: 'active' });
    bizB = await Business.create({ name: 'Rest B', email: 'b@example.test', plan: 'basic', subscriptionStatus: 'active' });
    for (const biz of [bizA, bizB]) {
      await Shift.create({ businessId: biz._id, name: 'Cena', startTime: '20:00', endTime: '23:00' });
    }

    addUser({ id: 'ownerA' });
    addUser({ id: 'staffA' });
    addUser({ id: 'ownerB' });
    await BusinessMember.create({ userId: 'ownerA', businessId: bizA._id, role: 'owner' });
    await BusinessMember.create({ userId: 'staffA', businessId: bizA._id, role: 'staff' });
    await BusinessMember.create({ userId: 'ownerB', businessId: bizB._id, role: 'owner' });
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  const publicBooking = (biz, extra = {}) => ({
    businessId: String(biz._id),
    guestName: 'Ana Test',
    guestPhone: '+34 612 345 678',
    guestEmail: 'ana@example.test',
    date,
    time: '21:00',
    people: 2,
    consent: true,
    ...extra,
  });

  test('guest books online: reservation + customer are created', async () => {
    const res = await request(app).post('/api/reservations/public').send(publicBooking(bizA));
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const saved = await Reservation.findOne({ businessId: bizA._id, guestName: 'Ana Test' });
    assert.ok(saved, 'reservation stored');
    assert.equal(saved.status, 'confirmed');
    assert.ok(saved.publicToken, 'has a public token for email links');

    const customer = await Customer.findOne({ businessId: bizA._id, normalizedPhone: '612345678' });
    assert.ok(customer, 'customer created with normalized phone');
  });

  test('same booking twice within 2 minutes is rejected', async () => {
    const res = await request(app).post('/api/reservations/public').send(publicBooking(bizA));
    assert.equal(res.status, 409);
  });

  test('slot outside any shift is rejected', async () => {
    const res = await request(app).post('/api/reservations/public').send(publicBooking(bizA, { time: '10:00', guestName: 'Luis' }));
    assert.equal(res.status, 400);
  });

  test('guest can cancel with the token from the email', async () => {
    const saved = await Reservation.findOne({ businessId: bizA._id, guestName: 'Ana Test' });
    const res = await request(app).post('/api/reservations/public/cancel')
      .send({ reservationId: String(saved._id), token: saved.publicToken });
    assert.ok([200, 204].includes(res.status), `status ${res.status}: ${JSON.stringify(res.body)}`);
    const after = await Reservation.findById(saved._id);
    assert.equal(after.status, 'cancelled');
  });

  test('a business never sees another business reservations', async () => {
    await Reservation.create({ businessId: bizB._id, guestName: 'Secreto B', date, time: '21:00', people: 2 });
    // ownerA asks explicitly for business B: must fall back to A's data
    const res = await request(app).get(`/api/reservations?date=${date}`)
      .set('x-test-user', 'ownerA').set('x-business-id', String(bizB._id));
    assert.equal(res.status, 200);
    const names = (Array.isArray(res.body) ? res.body : res.body.reservations || []).map((r) => r.guestName);
    assert.ok(!names.includes('Secreto B'), `leaked: ${names.join(', ')}`);
  });

  test('staff role cannot use manager actions', async () => {
    const r = await Reservation.create({ businessId: bizA._id, guestName: 'Pepe', date, time: '20:30', people: 2 });
    const res = await request(app).put(`/api/reservations/${r._id}/no-show`).set('x-test-user', 'staffA').send({});
    assert.equal(res.status, 403);
  });

  test('modules follow the plan: Basic cannot open staff module, Pro can', async () => {
    const basic = await request(app).get('/api/staff/employees').set('x-test-user', 'ownerB');
    assert.equal(basic.status, 403);
    assert.equal(basic.body.upgradeRequired, true);
    const pro = await request(app).get('/api/staff/employees').set('x-test-user', 'ownerA');
    assert.equal(pro.status, 200);
  });
});
