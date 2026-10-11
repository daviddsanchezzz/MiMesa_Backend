/**
 * Security fix: GET /api/shifts/public/slots and .../month-availability read
 * businessId straight from req.query into Mongoose filters without validating
 * it's a plain ObjectId string. Express's query parser turns
 * `businessId[$ne]=null` into req.query.businessId = { $ne: null }, which
 * Mongoose casts through, bypassing the per-business filter entirely and
 * leaking another tenant's shifts (flagged by a background security review
 * of the commit that touched this controller).
 *
 * Uses an in-memory MongoDB so it runs without MONGO_TEST_URI.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { ROOT } = require('../helpers/load');

describe('GET /api/shifts/public/slots rejects a non-ObjectId businessId', () => {
  let mongoose, mongod, app;
  let Business, Shift;
  let bizA, bizB;

  before(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri(), { dbName: 'vetra_shift_public_slots_injection_test' });

    const mod = require(path.join(ROOT, 'app'));
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;

    Business = require(path.join(ROOT, 'core/models/Business'));
    Shift = require(path.join(ROOT, 'verticals/restaurant/models/Shift'));
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([Business.deleteMany({}), Shift.deleteMany({})]);
    bizA = await Business.create({ name: 'Rest A', email: `a-${Date.now()}@example.test`, plan: 'free', subscriptionStatus: 'active' });
    bizB = await Business.create({ name: 'Rest B', email: `b-${Date.now()}@example.test`, plan: 'free', subscriptionStatus: 'active' });
  });

  const FUTURE_DATE = '2027-06-02';
  const DAY_OF_WEEK = new Date(`${FUTURE_DATE}T12:00:00Z`).getDay();

  test('a MongoDB operator as businessId never returns another business\'s shifts', async () => {
    await Shift.create({ businessId: bizB._id, name: 'Secreto de B', startTime: '20:00', endTime: '20:00', days: [DAY_OF_WEEK] });
    // No shift for bizA — a legitimate lookup would return [].

    const res = await request(app)
      .get('/api/shifts/public/slots')
      .query({ date: FUTURE_DATE, 'businessId[$ne]': 'null' });

    // Must be rejected as a bad request, not silently matched against every business.
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.body).includes('Secreto de B'));
  });

  test('still works normally with a real businessId', async () => {
    await Shift.create({ businessId: bizA._id, name: 'Cena', startTime: '20:00', endTime: '20:00', days: [DAY_OF_WEEK] });

    const res = await request(app).get('/api/shifts/public/slots').query({ date: FUTURE_DATE, businessId: String(bizA._id) });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((s) => s.shiftName), ['Cena']);
  });
});

describe('GET /api/shifts/public/month-availability rejects a non-ObjectId businessId', () => {
  let mongoose, mongod, app;
  let Business;

  before(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri(), { dbName: 'vetra_month_availability_injection_test' });

    const mod = require(path.join(ROOT, 'app'));
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;

    Business = require(path.join(ROOT, 'core/models/Business'));
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Business.deleteMany({});
  });

  test('a MongoDB operator as businessId is rejected', async () => {
    const res = await request(app)
      .get('/api/shifts/public/month-availability')
      .query({ year: '2027', month: '6', 'businessId[$ne]': 'null' });

    assert.equal(res.status, 400);
  });
});
