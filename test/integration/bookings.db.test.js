/**
 * End-to-end tests of the generic agenda (modules/bookings) through the HTTP
 * API against a real MongoDB-compatible database. Skipped unless
 * MONGO_TEST_URI is set (see reservations.db.test.js).
 *
 * Scenario: a hair salon with two hairdressers, plus a restaurant-style pool
 * service and a therapist with an optional room.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

// A Tuesday about three weeks ahead, in Madrid local time.
function nextTuesday(minDaysAhead = 14) {
  const d = new Date(Date.now() + minDaysAhead * 86400000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('generic agenda (bookings module)', { skip }, () => {
  let app, mongoose, Business, BusinessMember, Occupancy, Customer;
  let biz, other;
  const day = nextTuesday();
  const as = (user) => ({ 'x-test-user': user });
  const ids = {};

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_bookings_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    Customer = require(path.join(ROOT, 'core/models/Customer'));
    Occupancy = require(path.join(ROOT, 'modules/bookings/models/Occupancy'));
    await Occupancy.init(); // make sure the unique index exists before racing

    biz = await Business.create({
      name: 'Peluquería Test', email: 'pelu@example.test', plan: 'basic', subscriptionStatus: 'active',
      timezone: 'Europe/Madrid', moduleOverrides: { bookings: { enabled: true } },
    });
    other = await Business.create({ name: 'Sin agenda', email: 'other@example.test', plan: 'pro', subscriptionStatus: 'active' });
    addUser({ id: 'owner' });
    addUser({ id: 'staff' });
    addUser({ id: 'otherOwner' });
    await BusinessMember.create({ userId: 'owner', businessId: biz._id, role: 'owner' });
    await BusinessMember.create({ userId: 'staff', businessId: biz._id, role: 'staff' });
    await BusinessMember.create({ userId: 'otherOwner', businessId: other._id, role: 'owner' });
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('a new appointments business has the agenda on from the start', async () => {
    addUser({ id: 'salonOwner', email: 'salon@example.test' });
    const created = await request(app).post('/api/businesses').set(as('salonOwner'))
      .send({ name: 'Salón Nuevo', email: 'salon-nuevo@example.test', businessType: 'appointments' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.businessType, 'appointments');
    const me = await request(app).get('/api/auth/me').set(as('salonOwner'));
    assert.equal(me.body.businessType, 'appointments');
    assert.equal(me.body.modules.bookings.enabled, true);
    const res = await request(app).get('/api/bookings/services').set(as('salonOwner'));
    assert.equal(res.status, 200);
    const bad = await request(app).post('/api/businesses').set(as('salonOwner'))
      .send({ name: 'X', email: 'x@example.test', businessType: 'garage' });
    assert.equal(bad.status, 400);
  });

  test('module is off unless enabled for the business', async () => {
    const res = await request(app).get('/api/bookings/services').set(as('otherOwner'));
    assert.equal(res.status, 403);
    const pub = await request(app).get(`/api/bookings/public/${other._id}/catalog`);
    assert.equal(pub.status, 404);
  });

  test('owner sets up hairdressers, opening hours and services', async () => {
    let res = await request(app).post('/api/bookings/resources').set(as('owner')).send({ kind: 'staff', name: 'Ana', sortOrder: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.ana = res.body._id;
    res = await request(app).post('/api/bookings/resources').set(as('owner')).send({ kind: 'staff', name: 'Luis', sortOrder: 2 });
    ids.luis = res.body._id;
    res = await request(app).post('/api/bookings/resources').set(as('owner')).send({ kind: 'space', name: 'Despacho', bookableOnline: true });
    ids.room = res.body._id;

    res = await request(app).put('/api/bookings/schedule').set(as('owner')).send({
      rules: [{ days: [2, 3, 4, 5, 6], start: '09:00', end: '14:00' }, { days: [2, 3, 4, 5], start: '16:00', end: '20:00' }],
      overrides: [{ from: '2026-12-25', closed: true, reason: 'Navidad' }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Luis only works afternoons
    res = await request(app).put('/api/bookings/schedule').set(as('owner'))
      .send({ ownerType: 'resource', ownerId: ids.luis, rules: [{ days: [2, 3, 4, 5], start: '16:00', end: '20:00' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    res = await request(app).post('/api/bookings/services').set(as('owner')).send({
      name: 'Corte', durationMin: 30, slotIntervalMin: 30,
      requirements: [{ kind: 'staff', customerCanChoose: true }],
      price: { amount: 1800 },
      onlineBooking: { enabled: true, minNoticeHours: 2, maxDaysAhead: 60 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.corte = res.body._id;

    res = await request(app).post('/api/bookings/services').set(as('owner')).send({
      name: 'Tinte', durationMin: 60, bufferAfterMin: 10, slotIntervalMin: 30,
      requirements: [{ kind: 'staff', resourceIds: [ids.ana], customerCanChoose: true }],
      price: { amount: 4500 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.tinte = res.body._id;
  });

  test('bad setup is rejected with clear messages', async () => {
    let res = await request(app).post('/api/bookings/services').set(as('owner')).send({ name: 'Sin recursos', durationMin: 30 });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /recurso obligatorio/);
    res = await request(app).post('/api/bookings/services').set(as('owner')).send({ name: 'Raro', durationMin: 33, requirements: [{ kind: 'staff' }] });
    assert.equal(res.status, 400);
    res = await request(app).post('/api/bookings/services').set(as('owner'))
      .send({ name: 'Ajeno', durationMin: 30, requirements: [{ kind: 'staff', resourceIds: ['64b000000000000000000001'] }] });
    assert.equal(res.status, 400);
    res = await request(app).post('/api/bookings/resources').set(as('staff')).send({ kind: 'staff', name: 'X' });
    assert.equal(res.status, 403, 'staff cannot change setup');
  });

  test('availability: Ana in the morning, both in the afternoon', async () => {
    const res = await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=${day}`).set(as('staff'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const times = res.body.map((s) => s.time);
    assert.equal(times[0], '09:00');
    assert.ok(times.includes('16:00'));
    assert.ok(!times.includes('14:00'));
    const morning = res.body.find((s) => s.time === '09:00');
    assert.deepEqual(morning.resourceIds, [[ids.ana]]);
  });

  test('guest books online and gets a token; customer is created', async () => {
    const res = await request(app).post(`/api/bookings/public/${biz._id}/bookings`).send({
      date: day, time: '09:00', items: [{ serviceId: ids.corte }],
      guestName: 'Marta', guestPhone: '+34 611 222 333', guestEmail: 'marta@example.test', consent: true,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.token);
    assert.equal(res.body.status, 'confirmed');
    ids.martaBooking = res.body.id;
    ids.martaToken = res.body.token;
    assert.ok(await Customer.findOne({ businessId: biz._id, normalizedPhone: '611222333' }));
  });

  test('the taken slot disappears for the public', async () => {
    const res = await request(app).get(`/api/bookings/public/${biz._id}/availability?serviceId=${ids.corte}&from=${day}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((s) => s.time === '09:00'), 'Ana is the only one in the morning');
    assert.ok(!('resourceIds' in res.body[0]), 'guests do not see resource ids');
  });

  test('two guests racing for the same last slot: exactly one wins', async () => {
    const body = (name) => ({
      date: day, time: '10:00', items: [{ serviceId: ids.corte }],
      guestName: name, guestPhone: '600000000', guestEmail: `${name}@example.test`, consent: true,
    });
    const results = await Promise.all(['a', 'b', 'c'].map((n) => request(app).post(`/api/bookings/public/${biz._id}/bookings`).send(body(n))));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409], JSON.stringify(results.map((r) => r.body)));
  });

  test('two services in a row: corte + tinte with Ana', async () => {
    const res = await request(app).post('/api/bookings').set(as('staff')).send({
      date: day, time: '11:00', items: [{ serviceId: ids.corte }, { serviceId: ids.tinte }],
      guestName: 'Carla', guestPhone: '622000111', source: 'phone',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.segments.length, 2);
    assert.equal(res.body.totalPrice, 1800 + 4500);
    const [a, b] = res.body.segments;
    assert.equal(new Date(b.start).getTime(), new Date(a.end).getTime());
    // tinte 11:30–12:30 + 10 min buffer → Ana busy until 12:40; 12:30 corte must not fit with Ana
    const avail = await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=${day}&resourceId=${ids.ana}`).set(as('staff'));
    const t = avail.body.map((s) => s.time);
    assert.ok(!t.includes('12:30'));
    assert.ok(t.includes('13:00'));
  });

  test('choosing a professional who does not do that service is refused', async () => {
    const res = await request(app).post('/api/bookings').set(as('staff')).send({
      date: day, time: '17:00', items: [{ serviceId: ids.tinte, resourceId: ids.luis }], guestName: 'Pepe',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'no_resource');
  });

  test('guest cancels with the token and the slot is free again', async () => {
    const details = await request(app).get(`/api/bookings/public/cancel?bookingId=${ids.martaBooking}&token=${ids.martaToken}`);
    assert.equal(details.status, 200);
    const wrong = await request(app).post('/api/bookings/public/cancel').send({ bookingId: ids.martaBooking, token: 'x'.repeat(48) });
    assert.equal(wrong.status, 404);
    const res = await request(app).post('/api/bookings/public/cancel').send({ bookingId: ids.martaBooking, token: ids.martaToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'cancelled');
    assert.equal(await Occupancy.countDocuments({ bookingId: ids.martaBooking }), 0);
    const again = await request(app).post(`/api/bookings/public/${biz._id}/bookings`).send({
      date: day, time: '09:00', items: [{ serviceId: ids.corte }],
      guestName: 'Nuria', guestPhone: '633444555', guestEmail: 'nuria@example.test', consent: true,
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });

  test('status flow: confirmed → checked_in → completed; invalid jumps refused', async () => {
    const list = await request(app).get(`/api/bookings?from=${day}`).set(as('staff'));
    assert.equal(list.status, 200);
    const carla = list.body.find((b) => b.guestName === 'Carla');
    assert.ok(carla && !('publicToken' in carla));
    let res = await request(app).patch(`/api/bookings/${carla._id}/status`).set(as('staff')).send({ status: 'checked_in' });
    assert.equal(res.status, 200);
    res = await request(app).patch(`/api/bookings/${carla._id}/status`).set(as('staff')).send({ status: 'completed' });
    assert.equal(res.status, 200);
    res = await request(app).patch(`/api/bookings/${carla._id}/status`).set(as('staff')).send({ status: 'confirmed' });
    assert.equal(res.status, 400);
  });

  test('another business cannot read these bookings', async () => {
    await BusinessMember.create({ userId: 'otherOwner', businessId: other._id, role: 'owner' }).catch(() => {});
    await Business.updateOne({ _id: other._id }, { moduleOverrides: { bookings: { enabled: true } } });
    const res = await request(app).get(`/api/bookings?from=${day}`).set(as('otherOwner')).set('x-business-id', String(biz._id));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
  });

  test('pool capacity service (restaurant-style) fills up', async () => {
    let res = await request(app).post('/api/bookings/services').set(as('owner')).send({
      name: 'Taller grupal', durationMin: 60, slotIntervalMin: 60, capacityMode: 'pool', poolCapacity: 5,
      partySize: { min: 1, max: 5 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sid = res.body._id;
    const book = (n) => request(app).post('/api/bookings').set(as('staff'))
      .send({ date: day, time: '16:00', items: [{ serviceId: sid }], partySize: n, guestName: `G${n}` });
    assert.equal((await book(3)).status, 201);
    assert.equal((await book(2)).status, 201);
    const full = await book(1);
    assert.equal(full.status, 409);
    assert.equal(full.body.reason, 'pool_full');
  });

  test('therapist: optional room is used when free, skipped when not', async () => {
    let res = await request(app).post('/api/bookings/services').set(as('owner')).send({
      name: 'Sesión', durationMin: 50, bufferAfterMin: 10, slotIntervalMin: 60,
      requirements: [{ kind: 'staff', resourceIds: [ids.luis] }, { kind: 'space', optional: true }],
      tax: { rate: 0, exemptReason: 'art20_sanitario' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sid = res.body._id;
    res = await request(app).post('/api/bookings').set(as('staff')).send({ date: day, time: '18:00', items: [{ serviceId: sid }], guestName: 'P1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.segments[0].resourceIds.sort(), [ids.luis, ids.room].sort());
  });

  test('the database itself refuses a second booking of the same resource and time', async () => {
    // Bypass the in-process lock: write occupancy cells directly, as a second server would.
    const taken = await Occupancy.findOne({ resourceId: ids.ana }).lean();
    assert.ok(taken, 'Ana has occupied cells');
    await assert.rejects(
      Occupancy.create({ businessId: biz._id, resourceId: ids.ana, cell: taken.cell, bookingId: new mongoose.Types.ObjectId() }),
      (err) => err.code === 11000,
    );
  });

  test('closed day from override', async () => {
    const res = await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=2026-12-25`).set(as('staff'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });
});
