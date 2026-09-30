/**
 * Appointment plan limits against a real database (skipped without MONGO_TEST_URI):
 * professionals per plan, monthly quota on Free, reminders and follow-ups by
 * plan, professionals over the limit after a downgrade, and legacy access for
 * businesses that existed before the limits.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

function nextTuesday(minDaysAhead = 14) {
  const d = new Date(Date.now() + minDaysAhead * 86400000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('appointment plan limits', { skip }, () => {
  let app, mongoose, Business, BusinessMember, Booking;
  const as = (user) => ({ 'x-test-user': user });
  const sent = [];

  async function salon(key, plan, extra = {}) {
    const b = await Business.create({
      name: `Salón ${key}`, email: `${key}@example.test`, plan, subscriptionStatus: plan === 'free' ? null : 'active',
      businessType: 'appointments', timezone: 'Europe/Madrid', ...extra,
    });
    addUser({ id: key });
    await BusinessMember.create({ userId: key, businessId: b._id, role: 'owner', userEmail: `${key}@example.test` });
    await request(app).put('/api/bookings/schedule').set(as(key)).send({ rules: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '20:00' }] });
    return b;
  }
  const addPro = (key, name) => request(app).post('/api/bookings/resources').set(as(key)).send({ kind: 'staff', name });
  async function addService(key) {
    const r = await request(app).post('/api/bookings/services').set(as(key)).send({
      name: 'Corte', durationMin: 30, requirements: [{ kind: 'staff', customerCanChoose: true }], price: { amount: 1500 },
      onlineBooking: { enabled: true, minNoticeHours: 0, maxDaysAhead: 60 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body._id;
  }

  before(async () => {
    installFakeAuth();
    const delivery = require.resolve(path.join(ROOT, 'core/services/emailDelivery'));
    require(delivery);
    require.cache[delivery].exports.sendTrackedEmail = async ({ payload, source }) => {
      sent.push({ source, to: [].concat(payload.to) });
      return { data: { id: 'test' } };
    };
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_plans_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    await require(path.join(ROOT, 'modules/bookings/models/Occupancy')).init();
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('existing businesses keep everything once the limits arrive (runs once)', async () => {
    const { ensurePlanLimitsMigration } = require(path.join(ROOT, 'core/services/planLimitsMigration'));
    const old = await Business.create({ name: 'De antes', email: 'antes@example.test', plan: 'free', businessType: 'appointments' });
    assert.equal(await ensurePlanLimitsMigration({ log: {} }), 1);
    assert.equal((await Business.findById(old._id)).legacyAccess, true);
    const later = await Business.create({ name: 'Nuevo', email: 'nuevo@example.test', plan: 'free', businessType: 'appointments' });
    assert.equal(await ensurePlanLimitsMigration({ log: {} }), 0, 'only once');
    assert.equal((await Business.findById(later._id)).legacyAccess, false, 'new businesses follow their plan');
  });

  test('Free and Basic: one professional; Pro: the whole team', async () => {
    await salon('free1', 'free');
    await salon('basic1', 'basic');
    await salon('pro1', 'pro');
    for (const key of ['free1', 'basic1']) {
      assert.equal((await addPro(key, 'Ana')).status, 201);
      const second = await addPro(key, 'Luis');
      assert.equal(second.status, 403, key);
      assert.equal(second.body.code, 'PLAN_LIMIT');
      assert.equal(second.body.upgradeRequired, true);
      assert.match(second.body.message, /Pro/);
      // A room or equipment is not a professional
      assert.equal((await request(app).post('/api/bookings/resources').set(as(key)).send({ kind: 'space', name: 'Cabina' })).status, 201);
    }
    assert.equal((await addPro('pro1', 'Ana')).status, 201);
    assert.equal((await addPro('pro1', 'Luis')).status, 201);
    assert.equal((await addPro('pro1', 'Marta')).status, 201);

    // Deactivate and reactivate within the limit
    const list = await request(app).get('/api/bookings/resources').set(as('basic1'));
    const ana = list.body.find((r) => r.name === 'Ana');
    assert.equal((await request(app).delete(`/api/bookings/resources/${ana._id}`).set(as('basic1'))).status, 200);
    const luis = await addPro('basic1', 'Luis');
    assert.equal(luis.status, 201, 'room for one again');
    const back = await request(app).put(`/api/bookings/resources/${ana._id}`).set(as('basic1')).send({ active: true });
    assert.equal(back.status, 403, 'reactivating a second professional is over the limit');
  });

  test('after a downgrade the newest professionals take no new appointments', async () => {
    const b = await Business.findOne({ email: 'pro1@example.test' });
    const serviceId = await addService('pro1');
    let cat = await request(app).get(`/api/bookings/public/${b._id}/catalog`);
    assert.equal(cat.body.staff.length, 3);
    await Business.updateOne({ _id: b._id }, { plan: 'basic' });
    cat = await request(app).get(`/api/bookings/public/${b._id}/catalog`);
    assert.deepEqual(cat.body.staff.map((s) => s.name), ['Ana'], 'only the first professional is offered');
    const resources = await request(app).get('/api/bookings/resources').set(as('pro1'));
    const marta = resources.body.find((r) => r.name === 'Marta');
    const day = nextTuesday();
    const slots = await request(app).get(`/api/bookings/public/${b._id}/availability?serviceId=${serviceId}&from=${day}&resourceId=${marta._id}`);
    assert.equal(slots.status, 200);
    assert.equal(slots.body.length, 0, 'no times with a resting professional');
    await Business.updateOne({ _id: b._id }, { plan: 'pro' });
    const again = await request(app).get(`/api/bookings/public/${b._id}/availability?serviceId=${serviceId}&from=${day}&resourceId=${marta._id}`);
    assert.ok(again.body.length > 0, 'back on Pro: available again');
  });

  test('Free: 30 appointments a month, then a clear message (online and at the desk)', async () => {
    const b = await Business.findOne({ email: 'free1@example.test' });
    const serviceId = await addService('free1');
    const now = new Date();
    await Booking.insertMany(Array.from({ length: 30 }, (_, i) => ({
      businessId: b._id, guestName: `C${i}`, status: 'confirmed', start: new Date(now.getTime() - 86400000), end: new Date(now.getTime() - 86400000 + 1800000),
      segments: [{ serviceId, start: now, end: now, busyStart: now, busyEnd: now }],
    })));
    const day = nextTuesday();
    const desk = await request(app).post('/api/bookings').set(as('free1')).send({ date: day, time: '10:00', items: [{ serviceId }], guestName: 'Uno más', source: 'phone' });
    assert.equal(desk.status, 403);
    assert.equal(desk.body.code, 'PLAN_LIMIT');
    assert.match(desk.body.message, /30 citas/);
    const online = await request(app).post(`/api/bookings/public/${b._id}/bookings`).send({
      date: day, time: '11:00', items: [{ serviceId }], guestName: 'Online', guestPhone: '600000001', guestEmail: 'o@example.test', consent: true,
    });
    assert.equal(online.status, 403);
    assert.match(online.body.message, /Llama/);
    // Basic has no monthly limit
    const basic = await Business.findOne({ email: 'basic1@example.test' });
    const s2 = await addService('basic1');
    const ok = await request(app).post(`/api/bookings/public/${basic._id}/bookings`).send({
      date: day, time: '11:00', items: [{ serviceId: s2 }], guestName: 'Online', guestPhone: '600000002', guestEmail: 'o2@example.test', consent: true,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  test('follow-ups are Pro; legacy businesses keep them', async () => {
    let r = await request(app).get('/api/bookings/follow-ups').set(as('basic1'));
    assert.equal(r.body.available, false);
    r = await request(app).put('/api/bookings/follow-ups').set(as('basic1')).send({ rebook: { enabled: true } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PLAN_LIMIT');
    r = await request(app).put('/api/bookings/follow-ups').set(as('basic1')).send({ rebook: { enabled: false } });
    assert.equal(r.status, 200, 'turning off is always allowed');
    r = await request(app).put('/api/bookings/follow-ups').set(as('pro1')).send({ rebook: { enabled: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);

    await salon('legacy1', 'basic', { legacyAccess: true });
    r = await request(app).put('/api/bookings/follow-ups').set(as('legacy1')).send({ rebook: { enabled: true } });
    assert.equal(r.status, 200, 'legacy business keeps follow-ups');
    assert.equal((await addPro('legacy1', 'Ana')).status, 201);
    assert.equal((await addPro('legacy1', 'Luis')).status, 201, 'legacy business keeps its team');
  });

  test('reminders: Basic and Pro send them, Free does not', async () => {
    const { runBookingReminders } = require(path.join(ROOT, 'modules/bookings/jobs/bookingReminders'));
    const soon = new Date(Date.now() + 20 * 3600000);
    const make = async (email) => {
      const b = await Business.findOne({ email });
      const svc = await request(app).get('/api/bookings/services').set(as(email.split('@')[0]));
      return Booking.create({
        businessId: b._id, guestName: 'Rec', guestEmail: `rec-${email}`, status: 'confirmed', start: soon, end: new Date(soon.getTime() + 1800000),
        createdAt: new Date(Date.now() - 3 * 86400000),
        segments: [{ serviceId: svc.body[0]._id, start: soon, end: soon, busyStart: soon, busyEnd: soon }],
      });
    };
    const f = await make('free1@example.test');
    const bsc = await make('basic1@example.test');
    sent.length = 0;
    await runBookingReminders(new Date());
    await new Promise((r) => setTimeout(r, 100));
    const to = sent.filter((e) => e.source === 'booking.reminder').map((e) => e.to[0]);
    assert.ok(to.includes('rec-basic1@example.test'));
    assert.ok(!to.includes('rec-free1@example.test'));
    assert.equal((await Booking.findById(f._id)).reminderSentAt.getTime(), 0, 'free: marked as handled');
    assert.ok((await Booking.findById(bsc._id)).reminderSentAt.getTime() > 0);
  });
});
