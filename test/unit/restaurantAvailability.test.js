/**
 * Availability logic for the restaurant vertical, extracted out of
 * reservationController.js into its own service (see docs/VETRA_AI_ARCHITECTURE.md
 * §9 risk 1 — a future "get_available_slots" AI tool needs a callable service,
 * not logic embedded in a controller).
 *
 * Uses an in-memory MongoDB (mongodb-memory-server) so it runs without
 * MONGO_TEST_URI, unlike test/integration/*.db.test.js.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROOT } = require('../helpers/load');

describe('restaurant availabilityService', () => {
  let mongoose, mongod, availability;
  let Business, Shift, Exception, Reservation;
  let business;
  const path = require('node:path');

  before(async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri(), { dbName: 'vetra_availability_test' });

    Business = require(path.join(ROOT, 'core/models/Business'));
    Shift = require(path.join(ROOT, 'verticals/restaurant/models/Shift'));
    Exception = require(path.join(ROOT, 'verticals/restaurant/models/Exception'));
    Reservation = require(path.join(ROOT, 'verticals/restaurant/models/Reservation'));
    availability = require(path.join(ROOT, 'verticals/restaurant/services/availabilityService'));
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      Business.deleteMany({}),
      Shift.deleteMany({}),
      Exception.deleteMany({}),
      Reservation.deleteMany({}),
    ]);
    business = await Business.create({
      name: 'Rest Test',
      email: `rest-${Date.now()}@example.test`,
      plan: 'free',
      subscriptionStatus: 'active',
      maxPeoplePerSlot: 10,
      reservationDuration: 90,
    });
  });

  // A fixed future Wednesday so `days` matching is deterministic regardless of when tests run.
  const WEDNESDAY = '2026-11-04';
  const DAY_OF_WEEK = new Date(`${WEDNESDAY}T12:00:00Z`).getDay(); // 3

  test('generateSlots produces 30-minute increments, end time included', () => {
    // Merged from origin/master: the end time is the last bookable slot (fixes an off-by-one);
    // a shift ending exactly at midnight is the one case that still stops before it.
    assert.deepEqual(availability.generateSlots('09:00', '11:00'), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  test('generateSlots stops before midnight when a shift ends at 00:00', () => {
    assert.deepEqual(availability.generateSlots('23:00', '00:00'), ['23:00', '23:30']);
  });

  test('getApplicableShiftSlotsForDate returns subShift times for a shift active that weekday', async () => {
    await Shift.create({
      businessId: business._id,
      name: 'Cena',
      startTime: '20:00',
      endTime: '20:00',
      days: [DAY_OF_WEEK],
      subShifts: [{ time: '20:00' }, { time: '20:30' }],
    });

    const slots = await availability.getApplicableShiftSlotsForDate(business._id, WEDNESDAY);

    assert.deepEqual(slots, [
      { shiftName: 'Cena', time: '20:00' },
      { shiftName: 'Cena', time: '20:30' },
    ]);
  });

  test('getApplicableShiftSlotsForDate ignores shifts that do not run on that weekday', async () => {
    await Shift.create({
      businessId: business._id,
      name: 'Solo domingos',
      startTime: '12:00',
      endTime: '13:00',
      days: [0],
    });

    const slots = await availability.getApplicableShiftSlotsForDate(business._id, WEDNESDAY);
    assert.deepEqual(slots, []);
  });

  test('getSlotLoad sums people from reservations whose 90-min window covers the target time', async () => {
    await Reservation.create([
      { businessId: business._id, guestName: 'A', date: WEDNESDAY, time: '20:00', people: 4, status: 'confirmed' },
      { businessId: business._id, guestName: 'B', date: WEDNESDAY, time: '20:00', people: 2, status: 'cancelled' },
      { businessId: business._id, guestName: 'C', date: WEDNESDAY, time: '20:30', people: 5, status: 'seated' },
    ]);

    // Both the 20:00 (90min window reaches 21:30) and 20:30 reservations cover 20:30 — cancelled excluded.
    const load = await availability.getSlotLoad({ businessId: business._id, date: WEDNESDAY, time: '20:30', durationMinutes: 90 });

    assert.equal(load, 9);
  });

  test('evaluateReservationStatus rejects capacity when no pending-approval control', async () => {
    await Reservation.create({ businessId: business._id, guestName: 'A', date: WEDNESDAY, time: '20:00', people: 8, status: 'confirmed' });

    const decision = await availability.evaluateReservationStatus({ business, businessId: business._id, date: WEDNESDAY, time: '20:00', people: 5 });

    assert.deepEqual(decision, { status: 'rejected_capacity', pendingReason: 'none' });
  });

  test('evaluateReservationStatus falls back to pending when the plan has pending-approval control', async () => {
    business.plan = 'basic';
    await business.save();
    await Reservation.create({ businessId: business._id, guestName: 'A', date: WEDNESDAY, time: '20:00', people: 8, status: 'confirmed' });

    const decision = await availability.evaluateReservationStatus({ business, businessId: business._id, date: WEDNESDAY, time: '20:00', people: 5 });

    assert.deepEqual(decision, { status: 'pending', pendingReason: 'slot_capacity' });
  });

  test('getAvailableSlots excludes a shift blocked by a "closed" exception', async () => {
    await Shift.create({ businessId: business._id, name: 'Cena', startTime: '20:00', endTime: '21:00', days: [DAY_OF_WEEK] });
    await Exception.create({ businessId: business._id, date: WEDNESDAY, shiftName: 'Cena', type: 'closed' });

    const slots = await availability.getAvailableSlots({ business, businessId: business._id, date: WEDNESDAY, people: 2 });

    assert.deepEqual(slots, []);
  });

  test('getAvailableSlots excludes a slot that would exceed capacity, keeps the rest', async () => {
    // 30-minute duration so the 20:00 slot's load doesn't overlap the later slots.
    business.reservationDuration = 30;
    await business.save();
    // generateSlots is end-inclusive, so a 20:00-21:00 shift yields 20:00, 20:30 and 21:00.
    await Shift.create({ businessId: business._id, name: 'Cena', startTime: '20:00', endTime: '21:00', days: [DAY_OF_WEEK] });
    await Reservation.create({ businessId: business._id, guestName: 'A', date: WEDNESDAY, time: '20:00', people: 9, status: 'confirmed' });

    const slots = await availability.getAvailableSlots({ business, businessId: business._id, date: WEDNESDAY, people: 5 });

    assert.deepEqual(slots.map((s) => s.time), ['20:30', '21:00']);
    assert.ok(slots.every((s) => s.status === 'confirmed'));
  });
});
