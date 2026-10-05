/**
 * End-to-end tests (HTTP API + a real MongoDB-compatible database) of what was
 * added to the appointments module for Estética: packs (bonos), loyalty,
 * campaign segments and consent, the calendar feed (.ics) and the Finanzas
 * permission. Skipped unless MONGO_TEST_URI is set (see reservations.db.test.js).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('bookings extras (packs, loyalty, segments, calendar)', { skip }, () => {
  let app, mongoose, biz, Booking, Customer;
  const as = (user) => ({ 'x-test-user': user });
  const ids = {};

  async function chargedBooking(customerId, serviceId, serviceName, price, hoursAgo = 3) {
    const start = new Date(Date.now() - hoursAgo * 3600000);
    const end = new Date(start.getTime() + 30 * 60000);
    return Booking.create({
      businessId: biz._id, customerId, guestName: 'Lucía', status: 'confirmed', start, end, totalPrice: price,
      segments: [{ serviceId, serviceName, start, end, busyStart: start, busyEnd: end, resourceIds: [ids.ana], price }],
    });
  }

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_extras_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    const Business = require(path.join(ROOT, 'core/models/Business'));
    const BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    Customer = require(path.join(ROOT, 'core/models/Customer'));
    Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    const Resource = require(path.join(ROOT, 'modules/bookings/models/Resource'));
    const Service = require(path.join(ROOT, 'modules/bookings/models/Service'));

    biz = await Business.create({
      name: 'Estética Test', email: 'e@example.test', plan: 'pro', subscriptionStatus: 'active',
      timezone: 'Europe/Madrid', businessType: 'appointments', address: 'Calle Mayor 1',
    });
    for (const [id, role] of [['owner', 'owner'], ['manager', 'manager'], ['staff', 'staff']]) {
      addUser({ id });
      await BusinessMember.create({ userId: id, businessId: biz._id, role });
    }
    ids.ana = (await Resource.create({ businessId: biz._id, kind: 'staff', name: 'Ana' }))._id;
    ids.laser = (await Service.create({ businessId: biz._id, name: 'Láser', durationMin: 30, price: { amount: 5000 }, requirements: [{ kind: 'staff' }] }))._id;
    ids.facial = (await Service.create({ businessId: biz._id, name: 'Facial', durationMin: 30, price: { amount: 3000 }, requirements: [{ kind: 'staff' }] }))._id;
    ids.customer = (await Customer.create({ businessId: biz._id, name: 'Lucía', email: 'lucia@example.test', phone: '600111222', normalizedPhone: '600111222' }))._id;
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('packs: sell, pay an appointment with a session, till totals, undo gives the session back', async () => {
    let res = await request(app).post('/api/bookings/packs').set(as('owner'))
      .send({ name: 'Bono láser x3', sessions: 3, price: 12000, serviceIds: [String(ids.laser)] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.pack = res.body._id;
    assert.equal((await request(app).post('/api/bookings/packs').set(as('staff')).send({ name: 'x', sessions: 3, price: 1 })).status, 403, 'only a manager edits the catalogue');

    res = await request(app).post(`/api/bookings/customers/${ids.customer}/packs`).set(as('staff')).send({ packId: ids.pack, method: 'cash' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.remaining, 3);
    ids.sold = res.body._id;

    const covered = await chargedBooking(ids.customer, ids.laser, 'Láser', 5000);
    res = await request(app).post(`/api/bookings/${covered._id}/checkout`).set(as('staff')).send({ packId: ids.sold });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.payment.method, 'pack');
    assert.equal(res.body.payment.total, 0);

    res = await request(app).get(`/api/bookings/customers/${ids.customer}/packs`).set(as('staff'));
    assert.equal(res.body[0].remaining, 2);
    assert.equal(res.body[0].status, 'active');

    res = await request(app).get('/api/bookings/cash').set(as('staff'));
    assert.equal(res.body.totals.cash, 12000, 'the pack sold is cash in the till');
    assert.equal(res.body.totals.packSales, 12000);
    assert.equal(res.body.totals.packSessions, 1);
    assert.equal(res.body.packSales.length, 1);

    // a pack for Láser does not cover a Facial
    const other = await chargedBooking(ids.customer, ids.facial, 'Facial', 3000, 4);
    res = await request(app).post(`/api/bookings/${other._id}/checkout`).set(as('staff')).send({ packId: ids.sold });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PACK_NOT_VALID');

    res = await request(app).delete(`/api/bookings/${covered._id}/checkout`).set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await request(app).get(`/api/bookings/customers/${ids.customer}/packs`).set(as('staff'));
    assert.equal(res.body[0].remaining, 3, 'the session came back');

    // an unused sale can be cancelled while the till is open
    assert.equal((await request(app).delete(`/api/bookings/customer-packs/${ids.sold}`).set(as('staff'))).status, 403);
    assert.equal((await request(app).delete(`/api/bookings/customer-packs/${ids.sold}`).set(as('owner'))).status, 200);
  });

  test('loyalty: the Nth paid visit earns the reward', async () => {
    let res = await request(app).put('/api/bookings/loyalty').set(as('owner')).send({ enabled: true, every: 2, reward: { type: 'percent', value: 10 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await request(app).get(`/api/bookings/customers/${ids.customer}/loyalty`).set(as('staff'));
    assert.equal(res.body.paidVisits, 0);
    assert.equal(res.body.rewardDue, false);

    const b = await chargedBooking(ids.customer, ids.facial, 'Facial', 3000, 5);
    assert.equal((await request(app).post(`/api/bookings/${b._id}/checkout`).set(as('staff')).send({ method: 'card' })).status, 200);
    res = await request(app).get(`/api/bookings/customers/${ids.customer}/loyalty`).set(as('staff'));
    assert.equal(res.body.paidVisits, 1);
    assert.equal(res.body.rewardDue, true, 'the 2nd visit is the reward');
    assert.equal((await request(app).put('/api/bookings/loyalty').set(as('staff')).send({ enabled: false, every: 2, reward: { type: 'percent', value: 10 } })).status, 403);
  });

  test('marketing consent recorded by the team, never forced back after an opt-out; segments only reach subscribers', async () => {
    let res = await request(app).put(`/api/customers/${ids.customer}`).set(as('manager')).send({ marketingSubscribed: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.marketingSubscribed, true);
    assert.equal(res.body.marketingConsentSource, 'staff');

    res = await request(app).get('/api/bookings/segments?type=all').set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reachable, 1);
    res = await request(app).get('/api/bookings/segments?type=service&serviceId=' + ids.facial).set(as('owner'));
    assert.equal(res.body.reachable, 1, 'she had a Facial charged');
    assert.equal((await request(app).get('/api/bookings/segments?type=nope').set(as('owner'))).status, 400);
    assert.equal((await request(app).get('/api/bookings/segments?type=all').set(as('staff'))).status, 403);

    res = await request(app).put(`/api/customers/${ids.customer}`).set(as('manager')).send({ marketingSubscribed: false });
    assert.equal(res.body.marketingSubscribed, false);
    assert.equal(res.body.marketingUnsubscribed, true);
    res = await request(app).put(`/api/customers/${ids.customer}`).set(as('manager')).send({ marketingSubscribed: true });
    assert.equal(res.status, 409, 'someone who opted out is not subscribed again');
    res = await request(app).get('/api/bookings/segments?type=all').set(as('owner'));
    assert.equal(res.body.reachable, 0);
  });

  test('calendar feed: secret link per professional, .ics with the appointments, reset kills the old link', async () => {
    const start = new Date(Date.now() + 2 * 86400000);
    const end = new Date(start.getTime() + 30 * 60000);
    await Booking.create({
      businessId: biz._id, customerId: ids.customer, guestName: 'María Calendario', guestPhone: '600999888', status: 'confirmed', start, end, totalPrice: 5000,
      segments: [{ serviceId: ids.laser, serviceName: 'Láser', start, end, busyStart: start, busyEnd: end, resourceIds: [ids.ana], price: 5000 }],
    });

    assert.equal((await request(app).get(`/api/bookings/resources/${ids.ana}/calendar`).set(as('staff'))).status, 403, 'staff cannot get someone else\'s link');
    let res = await request(app).get(`/api/bookings/resources/${ids.ana}/calendar`).set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.url, /\/api\/bookings\/public\/calendar\/[a-f0-9]{48}\.ics$/);
    assert.match(res.body.webcalUrl, /^webcal:/);
    const token = res.body.url.match(/calendar\/([a-f0-9]{48})\.ics/)[1];
    const again = await request(app).get(`/api/bookings/resources/${ids.ana}/calendar`).set(as('owner'));
    assert.equal(again.body.url, res.body.url, 'the link is stable until reset');

    // calendar apps do not log in
    res = await request(app).get(`/api/bookings/public/calendar/${token}.ics`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/calendar/);
    assert.match(res.text, /BEGIN:VCALENDAR/);
    assert.match(res.text, /SUMMARY:María Calendario · Láser/);
    assert.match(res.text, /LOCATION:Calle Mayor 1/);
    assert.equal((await request(app).get(`/api/bookings/public/calendar/${'0'.repeat(48)}.ics`)).status, 404);

    res = await request(app).post(`/api/bookings/resources/${ids.ana}/calendar/reset`).set(as('owner'));
    assert.equal(res.status, 200);
    assert.notEqual(res.body.url.match(/calendar\/([a-f0-9]{48})/)[1], token);
    assert.equal((await request(app).get(`/api/bookings/public/calendar/${token}.ics`)).status, 404, 'the old link stopped working');

    // the token is never sent with the resource
    res = await request(app).get('/api/bookings/resources').set(as('owner'));
    assert.ok(!JSON.stringify(res.body).includes('calendarToken'));
  });

  test('Finanzas is for the owner on the API too', async () => {
    assert.equal((await request(app).get('/api/expenses').set(as('manager'))).status, 403);
    assert.equal((await request(app).get('/api/expenses').set(as('owner'))).status, 200);
    assert.equal((await request(app).get('/api/revenue/dashboard?from=2026-10-01&to=2026-10-31').set(as('manager'))).status, 403);
  });
});
