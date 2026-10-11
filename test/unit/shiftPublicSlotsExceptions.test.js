/**
 * GET /api/shifts/public/slots is what the public reservation page (and any
 * future "get_available_slots" AI tool, see docs/VETRA_AI_ARCHITECTURE.md §5)
 * uses to list bookable times. It must agree with what
 * createPublicReservation actually allows — otherwise a guest (or an AI
 * agent) is shown a time that gets rejected the moment they try to book it.
 *
 * Uses an in-memory MongoDB so it runs without MONGO_TEST_URI.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { ROOT } = require('../helpers/load');

describe('GET /api/shifts/public/slots respects date/shift exceptions', () => {
  let mongoose, mongod, app;
  let Business, Shift, Exception;
  let business;

  before(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri(), { dbName: 'vetra_shift_public_slots_test' });

    const mod = require(path.join(ROOT, 'app'));
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;

    Business = require(path.join(ROOT, 'core/models/Business'));
    Shift = require(path.join(ROOT, 'verticals/restaurant/models/Shift'));
    Exception = require(path.join(ROOT, 'verticals/restaurant/models/Exception'));
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([Business.deleteMany({}), Shift.deleteMany({}), Exception.deleteMany({})]);
    business = await Business.create({
      name: 'Rest Test',
      email: `rest-${Date.now()}@example.test`,
      plan: 'free',
      subscriptionStatus: 'active',
    });
  });

  // Far enough in the future that minBookingNoticeHours/"already passed" never excludes it.
  const FUTURE_DATE = '2027-06-02'; // a Wednesday
  const DAY_OF_WEEK = new Date(`${FUTURE_DATE}T12:00:00Z`).getDay();

  test('lists shift slots when there is no exception', async () => {
    await Shift.create({ businessId: business._id, name: 'Cena', startTime: '20:00', endTime: '20:30', days: [DAY_OF_WEEK] });

    const res = await request(app).get('/api/shifts/public/slots').query({ businessId: String(business._id), date: FUTURE_DATE });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((s) => s.time), ['20:00', '20:30']);
  });

  test('excludes slots whose shift is closed by a date exception', async () => {
    await Shift.create({ businessId: business._id, name: 'Cena', startTime: '20:00', endTime: '20:30', days: [DAY_OF_WEEK] });
    await Exception.create({ businessId: business._id, date: FUTURE_DATE, shiftName: 'Cena', type: 'closed' });

    const res = await request(app).get('/api/shifts/public/slots').query({ businessId: String(business._id), date: FUTURE_DATE });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('a "full" exception on one shift does not affect a different shift the same day', async () => {
    await Shift.create([
      { businessId: business._id, name: 'Comida', startTime: '13:00', endTime: '13:30', days: [DAY_OF_WEEK] },
      { businessId: business._id, name: 'Cena', startTime: '20:00', endTime: '20:30', days: [DAY_OF_WEEK] },
    ]);
    await Exception.create({ businessId: business._id, date: FUTURE_DATE, shiftName: 'Comida', type: 'full' });

    const res = await request(app).get('/api/shifts/public/slots').query({ businessId: String(business._id), date: FUTURE_DATE });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((s) => s.shiftName), ['Cena', 'Cena']);
  });
});
