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
  const sent = []; // every email the app tries to send
  const waitForEmails = () => new Promise((r) => setTimeout(r, 150));

  before(async () => {
    installFakeAuth();
    // Capture emails instead of calling Resend (must run before the app loads).
    const delivery = require.resolve(path.join(ROOT, 'core/services/emailDelivery'));
    require(delivery);
    require.cache[delivery].exports.sendTrackedEmail = async ({ payload, source }) => {
      sent.push({ source, to: [].concat(payload.to), subject: payload.subject, html: payload.html });
      return { data: { id: 'test' } };
    };
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
      name: 'Peluquería Test', email: 'pelu@example.test', plan: 'pro', subscriptionStatus: 'active',
      timezone: 'Europe/Madrid', moduleOverrides: { bookings: { enabled: true } },
    });
    other = await Business.create({ name: 'Sin agenda', email: 'other@example.test', plan: 'pro', subscriptionStatus: 'active' });
    addUser({ id: 'owner' });
    addUser({ id: 'staff' });
    addUser({ id: 'otherOwner' });
    await BusinessMember.create({ userId: 'owner', businessId: biz._id, role: 'owner', userEmail: 'owner@pelu.test' });
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
    process.env.SIGNUP_MODE = 'open'; // self-service sign-up (invite-only is tested in onboarding.db.test.js)
    const created = await request(app).post('/api/businesses').set(as('salonOwner'))
      .send({ name: 'Salón Nuevo', email: 'salon-nuevo@example.test', businessType: 'appointments', acceptLegal: true });
    delete process.env.SIGNUP_MODE;
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.businessType, 'appointments');
    const me = await request(app).get('/api/auth/me').set(as('salonOwner'));
    assert.equal(me.body.businessType, 'appointments');
    assert.equal(me.body.modules.bookings.enabled, true);
    // No free plan: 14 days of Pro without a card
    assert.equal(me.body.effectivePlan, 'pro');
    assert.equal(me.body.subscriptionStatus, 'trialing');
    const days = (new Date(me.body.trialEndsAt) - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days <= 14, `trial ends in 14 days (${days})`);
    const res = await request(app).get('/api/bookings/services').set(as('salonOwner'));
    assert.equal(res.status, 200);
    // Without a sector: the owner as professional and opening hours, no services
    const pros = await request(app).get('/api/bookings/resources').set(as('salonOwner'));
    assert.equal(pros.body.filter((r) => r.kind === 'staff').length, 1);
    const tpl = await request(app).get('/api/businesses/templates').set(as('salonOwner'));
    assert.ok(tpl.body.some((t) => t.key === 'peluqueria' && t.businessType === 'appointments'));
    // With a sector: typical services too
    addUser({ id: 'barberOwner', email: 'barber@example.test', name: 'Toni Ruiz' });
    process.env.SIGNUP_MODE = 'open';
    const barber = await request(app).post('/api/businesses').set(as('barberOwner'))
      .send({ name: 'Barbería Toni', email: 'toni@example.test', businessType: 'appointments', template: 'barberia', acceptLegal: true });
    const wrong = await request(app).post('/api/businesses').set(as('barberOwner'))
      .send({ name: 'X', email: 'x2@example.test', businessType: 'restaurant', template: 'barberia', acceptLegal: true });
    delete process.env.SIGNUP_MODE;
    assert.equal(barber.status, 201, JSON.stringify(barber.body));
    assert.equal(barber.body.template, 'barberia');
    assert.equal(wrong.status, 400);
    const Service = require(path.join(ROOT, 'modules/bookings/models/Service'));
    const Resource = require(path.join(ROOT, 'modules/bookings/models/Resource'));
    assert.ok(await Service.countDocuments({ businessId: barber.body.id }) >= 5);
    assert.equal((await Resource.findOne({ businessId: barber.body.id, kind: 'staff' })).name, 'Toni');
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

  test('two services with "any professional" stay with the same person', async () => {
    const res = await request(app).post('/api/bookings').set(as('staff')).send({
      date: day, time: '19:00', items: [{ serviceId: ids.corte }, { serviceId: ids.corte }],
      guestName: 'Jaume', guestPhone: '622000999', source: 'phone',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [a, b] = res.body.segments;
    assert.deepEqual(b.resourceIds, a.resourceIds);
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

  test('online booking emails the customer and the owner; guest cancel emails the owner', async () => {
    sent.length = 0;
    const res = await request(app).post(`/api/bookings/public/${biz._id}/bookings`).send({
      date: day, time: '17:30', items: [{ serviceId: ids.corte }],
      guestName: 'Eva', guestPhone: '644555666', guestEmail: 'eva@example.test', consent: true,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await waitForEmails();
    const toGuest = sent.find((e) => e.source === 'booking.confirmed');
    const toOwner = sent.find((e) => e.source === 'booking.staff_created');
    assert.ok(toGuest && toGuest.to.includes('eva@example.test'), JSON.stringify(sent.map((e) => e.source)));
    assert.ok(toGuest.html.includes(`bookingId=${res.body.id}`), 'confirmation has the cancel link');
    assert.ok(toOwner && toOwner.to.includes('owner@pelu.test'));
    assert.ok(!toOwner.to.includes('staff@example.test'), 'plain staff members are not emailed');

    sent.length = 0;
    await request(app).post('/api/bookings/public/cancel').send({ bookingId: res.body.id, token: res.body.token });
    await waitForEmails();
    assert.deepEqual(sent.map((e) => e.source), ['booking.staff_cancelled']);
  });

  test('desk booking without email sends nothing; staff cancel emails the customer', async () => {
    sent.length = 0;
    const noEmail = await request(app).post('/api/bookings').set(as('staff'))
      .send({ date: day, time: '13:00', items: [{ serviceId: ids.corte }], guestName: 'Sin email' });
    assert.equal(noEmail.status, 201);
    const withEmail = await request(app).post('/api/bookings').set(as('staff'))
      .send({ date: day, time: '13:30', items: [{ serviceId: ids.corte }], guestName: 'Pau', guestEmail: 'pau@example.test' });
    await waitForEmails();
    assert.deepEqual(sent.map((e) => e.source), ['booking.confirmed']);
    sent.length = 0;
    await request(app).patch(`/api/bookings/${withEmail.body._id}/status`).set(as('staff')).send({ status: 'cancelled' });
    await waitForEmails();
    assert.deepEqual(sent.map((e) => e.source), ['booking.cancelled']);
  });

  test('reminder: sent once ~24h before, skipped for last-minute bookings', async () => {
    const Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    const { runBookingReminders } = require(path.join(ROOT, 'modules/bookings/jobs/bookingReminders'));
    const now = new Date();
    const inHours = (h) => new Date(now.getTime() + h * 3600000);
    const seg = (start) => [{ serviceId: ids.corte, serviceName: 'Corte', start, end: new Date(start.getTime() + 1800000),
      busyStart: start, busyEnd: new Date(start.getTime() + 1800000), resourceIds: [] }];
    const base = { businessId: biz._id, guestName: 'R', partySize: 1, source: 'online', status: 'confirmed' };
    const due = await Booking.create({ ...base, guestEmail: 'due@example.test', start: inHours(20), end: inHours(20.5), segments: seg(inHours(20)) });
    await Booking.updateOne({ _id: due._id }, { $set: { createdAt: inHours(-72) } }, { timestamps: false });
    const lastMinute = await Booking.create({ ...base, guestEmail: 'late@example.test', start: inHours(5), end: inHours(5.5), segments: seg(inHours(5)) });
    const tooFar = await Booking.create({ ...base, guestEmail: 'far@example.test', start: inHours(30), end: inHours(30.5), segments: seg(inHours(30)) });
    await Booking.updateOne({ _id: tooFar._id }, { $set: { createdAt: inHours(-72) } }, { timestamps: false });

    sent.length = 0;
    await runBookingReminders(now);
    const reminders = sent.filter((e) => e.source === 'booking.reminder').map((e) => e.to[0]);
    assert.deepEqual(reminders, ['due@example.test']);
    assert.ok((await Booking.findById(due._id)).reminderSentAt);
    assert.ok((await Booking.findById(lastMinute._id)).reminderSentAt, 'last-minute booking marked as handled');
    assert.equal((await Booking.findById(tooFar._id)).reminderSentAt, null);

    sent.length = 0;
    await Promise.all([runBookingReminders(now), runBookingReminders(now)]);
    assert.equal(sent.filter((e) => e.source === 'booking.reminder').length, 0, 'never sent twice');
  });

  test('closed day from override', async () => {
    const res = await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=2026-12-25`).set(as('staff'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('staff colour, photo and the services each person does', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    let res = await request(app).put(`/api/bookings/resources/${ids.luis}`).set(as('owner')).send({ color: '#0EA5E9', photo: png });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.color, '#0ea5e9');
    res = await request(app).put(`/api/bookings/resources/${ids.luis}`).set(as('owner')).send({ photo: 'data:text/html;base64,PGI+' });
    assert.equal(res.status, 400);
    res = await request(app).get(`/api/bookings/public/${biz._id}/catalog`);
    assert.equal(res.body.staff.find((s) => String(s.id) === ids.luis).color, '#0ea5e9');

    const staffOf = async (serviceId) => {
      const list = (await request(app).get('/api/bookings/services').set(as('owner'))).body;
      return list.find((x) => x._id === serviceId).requirements.find((r) => r.kind === 'staff').resourceIds.map(String).sort();
    };
    const sesion = (await request(app).get('/api/bookings/services').set(as('owner'))).body.find((x) => x.name === 'Sesión')._id;
    // Luis also does Tinte → everybody does it → back to "anyone"
    res = await request(app).put(`/api/bookings/resources/${ids.luis}/services`).set(as('owner')).send({ serviceIds: [ids.corte, ids.tinte, sesion] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await staffOf(ids.tinte), []);
    // Luis stops doing Corte → only Ana does it
    res = await request(app).put(`/api/bookings/resources/${ids.luis}/services`).set(as('owner')).send({ serviceIds: [ids.tinte, sesion] });
    assert.deepEqual(await staffOf(ids.corte), [ids.ana]);
    // Ana can't drop Corte: nobody else does it
    res = await request(app).put(`/api/bookings/resources/${ids.ana}/services`).set(as('owner')).send({ serviceIds: [ids.tinte] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Nadie más hace "Corte"/);
    res = await request(app).put(`/api/bookings/resources/${ids.luis}/services`).set(as('staff')).send({ serviceIds: [] });
    assert.equal(res.status, 403);
    // Back to how it was: Corte anyone, Tinte only Ana
    await request(app).put(`/api/bookings/resources/${ids.luis}/services`).set(as('owner')).send({ serviceIds: [ids.corte, sesion] });
    assert.deepEqual(await staffOf(ids.corte), []);
    assert.deepEqual(await staffOf(ids.tinte), [ids.ana]);
  });

  test('business logo: upload, public URL and removal', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    let res = await request(app).put('/api/auth/settings').set(as('owner')).send({ logo: png });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.logoUrl, new RegExp(`/api/auth/public/business/${biz._id}/logo\\?v=\\d+$`));
    assert.equal(res.body.logo, undefined, 'the image itself is not sent back');
    res = await request(app).get(`/api/auth/public/business/${biz._id}/logo`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    res = await request(app).get(`/api/bookings/public/${biz._id}/catalog`);
    assert.ok(res.body.business.logoUrl);
    res = await request(app).put('/api/auth/settings').set(as('owner')).send({ logo: 'nope' });
    assert.equal(res.status, 400);
    res = await request(app).put('/api/auth/settings').set(as('owner')).send({ logo: '' });
    assert.equal(res.body.logoUrl, null);
    assert.equal((await request(app).get(`/api/auth/public/business/${biz._id}/logo`)).status, 404);
  });

  test('dashboard stats for the business', async () => {
    const res = await request(app).get('/api/bookings/stats').set(as('staff'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const k of ['today', 'tomorrow', 'week', 'actions', 'money', 'team', 'topServices', 'customers']) assert.ok(k in res.body, k);
    assert.deepEqual(res.body.team.map((t) => t.name), ['Ana', 'Luis']);
    const theirs = await request(app).get('/api/bookings/stats').set(as('otherOwner'));
    assert.deepEqual(theirs.body.team, [], 'another business only sees its own numbers');
  });

  test('customer history: summary per customer and one customer file', async () => {
    const Customer = require(path.join(ROOT, 'core/models/Customer'));
    const c = await Customer.findOne({ businessId: biz._id, email: { $ne: '' } }).lean();
    assert.ok(c, 'online bookings created customers');
    let res = await request(app).get('/api/bookings/customers/summary').set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body[String(c._id)], 'summary keyed by customer id');
    res = await request(app).get(`/api/bookings/customers/${c._id}`).set(as('owner'));
    assert.equal(res.status, 200);
    assert.ok(res.body.bookings.length >= 1);
    assert.ok('dueBack' in res.body.summary);
    assert.equal((await request(app).get('/api/bookings/customers/summary').set(as('staff'))).status, 403);
    const other = await request(app).get(`/api/bookings/customers/${c._id}`).set(as('otherOwner'));
    assert.deepEqual(other.body.bookings, [], 'another business sees nothing');
  });

  test('caja: charge an appointment, till of the day, close and reopen', async () => {
    const Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    const start = new Date(Date.now() - 3 * 3600000);
    const end = new Date(start.getTime() + 30 * 60000);
    const b = await Booking.create({
      businessId: biz._id, guestName: 'Caja Uno', status: 'confirmed', start, end, totalPrice: 1800,
      segments: [{ serviceId: ids.corte, serviceName: 'Corte', start, end, busyStart: start, busyEnd: end, resourceIds: [ids.ana], price: 1800 }],
    });
    let res = await request(app).post(`/api/bookings/${b._id}/checkout`).set(as('staff'))
      .send({ method: 'cash', extras: [{ name: 'Laca', price: 900 }], tip: 200 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'completed');
    assert.equal(res.body.payment.total, 2700);
    res = await request(app).post(`/api/bookings/${b._id}/checkout`).set(as('staff')).send({ method: 'card' });
    assert.equal(res.status, 400, 'cannot charge twice');

    res = await request(app).get('/api/bookings/cash').set(as('staff'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.cash, 2900);
    assert.equal(res.body.totals.total, 2700);
    assert.equal(res.body.payments.length, 1);
    const date = res.body.date;

    res = await request(app).post('/api/bookings/cash/close').set(as('staff')).send({ date, countedCash: 2800, note: 'falta 1 €' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.difference, -100);
    assert.equal((await request(app).post('/api/bookings/cash/close').set(as('staff')).send({ date })).status, 409);
    assert.equal((await request(app).delete(`/api/bookings/${b._id}/checkout`).set(as('owner'))).status, 409, 'closed day is locked');
    assert.equal((await request(app).delete(`/api/bookings/cash/close?date=${date}`).set(as('staff'))).status, 403);
    assert.equal((await request(app).delete(`/api/bookings/cash/close?date=${date}`).set(as('owner'))).status, 200);
    res = await request(app).delete(`/api/bookings/${b._id}/checkout`).set(as('owner'));
    assert.equal(res.status, 200);
    assert.equal(res.body.payment, null);
    assert.equal((await request(app).delete(`/api/bookings/${b._id}/checkout`).set(as('staff'))).status, 403);
  });

  test('finanzas for appointment businesses: appointments, till and commissions', async () => {
    await Business.updateOne({ _id: biz._id }, { businessType: 'appointments', plan: 'pro', 'moduleOverrides.expenses': { enabled: true } });
    const Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    const start = new Date(Date.now() - 2 * 3600000);
    const end = new Date(start.getTime() + 30 * 60000);
    const b = await Booking.create({
      businessId: biz._id, guestName: 'Finanzas', status: 'confirmed', start, end, totalPrice: 4000,
      segments: [{ serviceId: ids.corte, serviceName: 'Corte', start, end, busyStart: start, busyEnd: end, resourceIds: [ids.ana], price: 4000 }],
    });
    await request(app).put(`/api/bookings/services/${ids.corte}`).set(as('owner')).send({ staffCommissionPercent: 10 });
    let res = await request(app).post(`/api/bookings/${b._id}/checkout`).set(as('owner')).send({ method: 'card', discount: 500 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const today = res.body.payment.date;
    res = await request(app).get(`/api/revenue/dashboard?from=${today}&to=${today}`).set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.mode, 'appointments');
    assert.ok(res.body.estimatedRevenue >= 40, 'billed includes the appointment');
    const day = res.body.days.find((d) => d.date === today);
    assert.ok(day.collected >= 35);
    assert.equal(day.actualSource, 'till');
    assert.ok(res.body.expensesByCategory.find((c) => c.category === 'commissions').amount >= 4);
    assert.ok(res.body.byStaff.find((s) => s.name === 'Ana').commission >= 4);
    // a manual figure for the day wins over the till
    await request(app).put('/api/revenue/actual').set(as('owner')).send({ date: today, actualRevenue: 99 });
    res = await request(app).get(`/api/revenue/dashboard?from=${today}&to=${today}`).set(as('owner'));
    assert.equal(res.body.days.find((d) => d.date === today).actualRevenue, 99);
    res = await request(app).get('/api/categories').set(as('owner'));
    await Business.updateOne({ _id: biz._id }, { businessType: 'restaurant', plan: 'pro' });
  });

  test('team: pay per professional, payments and finance salaries', async () => {
    await Business.updateOne({ _id: biz._id }, { businessType: 'appointments', plan: 'pro', 'moduleOverrides.expenses': { enabled: true }, 'moduleOverrides.staff': { enabled: true } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
    const monthStart = `${today.slice(0, 8)}01`;
    let res = await request(app).get(`/api/bookings/team?from=${monthStart}&to=${today}`).set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.staff.every((s) => s.employeeId), 'every professional gets a staff record');
    res = await request(app).put(`/api/bookings/team/${ids.ana}/pay`).set(as('owner')).send({ type: 'monthly', amount: 1500, commissionPercent: 10, productCommissionPercent: 5 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.paymentType, 'monthly_fixed');
    assert.equal((await request(app).put(`/api/bookings/team/${ids.ana}/pay`).set(as('owner')).send({ type: 'weekly' })).status, 400);
    assert.equal((await request(app).put(`/api/bookings/team/${ids.ana}/pay`).set(as('owner')).send({ type: 'commission', commissionPercent: 140 })).status, 400);
    res = await request(app).post(`/api/bookings/team/${ids.ana}/payments`).set(as('owner')).send({ amount: 200, notes: 'adelanto' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    res = await request(app).get(`/api/bookings/team?from=${monthStart}&to=${today}`).set(as('owner'));
    const ana = res.body.staff.find((s) => s.name === 'Ana');
    assert.equal(ana.pay.type, 'monthly_fixed');
    assert.ok(ana.salary > 0);
    assert.equal(ana.paid, 200);
    assert.equal((await request(app).get(`/api/bookings/team?from=${monthStart}&to=${today}`).set(as('staff'))).status, 403);
    res = await request(app).get(`/api/revenue/dashboard?from=${monthStart}&to=${today}`).set(as('owner'));
    assert.ok(res.body.expensesByCategory.find((c) => c.category === 'staff').amount > 0, 'salaries count as expense');
    await Business.updateOne({ _id: biz._id }, { businessType: 'restaurant', plan: 'pro' });
  });

  test('link an app user to a professional (Mi agenda)', async () => {
    let res = await request(app).put(`/api/bookings/resources/${ids.ana}`).set(as('owner')).send({ userId: 'staff' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.userId, 'staff');
    res = await request(app).put(`/api/bookings/resources/${ids.luis}`).set(as('owner')).send({ userId: 'staff' });
    assert.equal(res.body.userId, 'staff');
    const list = (await request(app).get('/api/bookings/resources').set(as('staff'))).body;
    assert.equal(list.find((r) => r._id === ids.ana).userId, null, 'moved from Ana to Luis');
    res = await request(app).put(`/api/bookings/resources/${ids.ana}`).set(as('owner')).send({ userId: 'otherOwner' });
    assert.equal(res.status, 400, 'not a member of this business');
    res = await request(app).put(`/api/bookings/resources/${ids.luis}`).set(as('owner')).send({ userId: null });
    assert.equal(res.body.userId, null);
  });
  test('absences: own agenda, blocked by appointments until moved, then no slots', async () => {
    const d2 = nextTuesday(28);
    let res = await request(app).put(`/api/bookings/resources/${ids.luis}`).set(as('owner')).send({ userId: 'staff' });
    assert.equal(res.status, 200);
    res = await request(app).post('/api/bookings').set(as('owner')).send({
      date: d2, time: '17:00', items: [{ serviceId: ids.corte, resourceId: ids.luis }], guestName: 'Queda con Luis', source: 'phone',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const bookingId = res.body._id;

    // Staff can only block their own professional
    res = await request(app).post('/api/bookings/absences').set(as('staff')).send({ resourceId: ids.ana, fromDate: d2, reason: 'x' });
    assert.equal(res.status, 403);

    // Own agenda, but there is an appointment → refused with the list
    res = await request(app).post('/api/bookings/absences').set(as('staff')).send({ resourceId: ids.luis, fromDate: d2, reason: 'Médico' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'HAS_BOOKINGS');
    assert.deepEqual(res.body.bookings.map((b) => b.guestName), ['Queda con Luis']);

    // Who could take it instead, then move it
    res = await request(app).get(`/api/bookings/${bookingId}/reassign-options?from=${ids.luis}`).set(as('staff'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.some((r) => r._id === ids.ana), 'Ana is free then');
    res = await request(app).patch(`/api/bookings/${bookingId}/reassign`).set(as('staff')).send({ from: ids.luis, to: ids.ana });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.segments[0].resourceIds, [ids.ana]);
    assert.equal(await Occupancy.countDocuments({ bookingId, resourceId: ids.luis }), 0);
    assert.ok(await Occupancy.countDocuments({ bookingId, resourceId: ids.ana }) > 0);

    // Now the whole day can be blocked
    res = await request(app).post('/api/bookings/absences').set(as('staff')).send({ resourceId: ids.luis, fromDate: d2, reason: 'Médico' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const absenceId = res.body._id;
    res = await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=${d2}&resourceId=${ids.luis}`).set(as('owner'));
    assert.deepEqual(res.body, [], 'no slots with Luis that day');
    res = await request(app).post('/api/bookings').set(as('owner')).send({
      date: d2, time: '18:00', items: [{ serviceId: ids.corte, resourceId: ids.luis }], guestName: 'No cabe',
    });
    assert.equal(res.status, 409);
    // Moving an appointment to someone absent is refused too
    res = await request(app).patch(`/api/bookings/${bookingId}/reassign`).set(as('owner')).send({ from: ids.ana, to: ids.luis });
    assert.equal(res.status, 409);

    // Some hours only: Ana 10:00–12:00
    res = await request(app).post('/api/bookings/absences').set(as('owner'))
      .send({ resourceId: ids.ana, fromDate: d2, allDay: false, startTime: '10:00', endTime: '12:00' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = (await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=${d2}&resourceId=${ids.ana}`).set(as('owner'))).body.map((x) => x.time);
    assert.ok(t.includes('09:30') && !t.includes('10:00') && !t.includes('11:30') && t.includes('12:00'), t.join(','));

    // The reason is private: the owner and Luis see it
    const list = (await request(app).get(`/api/bookings/absences?from=${d2}`).set(as('staff'))).body;
    assert.equal(list.find((a) => a._id === absenceId).reason, 'Médico');
    assert.equal(list.length, 2);

    // Remove it: Luis is bookable again
    res = await request(app).delete(`/api/bookings/absences/${absenceId}`).set(as('staff'));
    assert.equal(res.status, 200);
    res = await request(app).get(`/api/bookings/availability?serviceId=${ids.corte}&from=${d2}&resourceId=${ids.luis}`).set(as('owner'));
    assert.ok(res.body.length > 0);
    await request(app).put(`/api/bookings/resources/${ids.luis}`).set(as('owner')).send({ userId: null });
  });
  test('follow-ups: settings, review request after the visit, "te toca volver", opt-out', async () => {
    const Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    const { runReviewRequests, runRebookReminders } = require(path.join(ROOT, 'modules/bookings/services/followUpsService'));

    // Settings: managers only, review needs a Google link
    let res = await request(app).get('/api/bookings/follow-ups').set(as('staff'));
    assert.equal(res.status, 403);
    res = await request(app).get('/api/bookings/follow-ups').set(as('owner'));
    assert.deepEqual([res.body.rebook.enabled, res.body.review.enabled], [false, false]);
    res = await request(app).put('/api/bookings/follow-ups').set(as('owner')).send({ review: { enabled: true } });
    assert.equal(res.status, 400);
    res = await request(app).put('/api/bookings/follow-ups').set(as('owner')).send({ review: { enabled: true, url: 'javascript:alert(1)' } });
    assert.equal(res.status, 400);
    res = await request(app).put('/api/bookings/follow-ups').set(as('owner'))
      .send({ rebook: { enabled: true }, review: { enabled: true, url: 'https://g.page/r/test/review', delayHours: 2 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const now = new Date();
    const at = (hours) => new Date(now.getTime() + hours * 3600000);
    const seg = (start) => [{ serviceId: ids.corte, serviceName: 'Corte', start, end: new Date(start.getTime() + 1800000),
      busyStart: start, busyEnd: new Date(start.getTime() + 1800000), resourceIds: [ids.ana] }];
    const mk = async (customer, startH, extra = {}) => Booking.create({
      businessId: biz._id, customerId: customer._id, guestName: customer.name, guestEmail: customer.email, partySize: 1, source: 'phone',
      status: 'completed', start: at(startH), end: at(startH + 0.5), segments: seg(at(startH)), ...extra,
    });
    const rosa = await Customer.create({ businessId: biz._id, name: 'Rosa', email: 'rosa@example.test' });
    const nora = await Customer.create({ businessId: biz._id, name: 'Nora', email: 'nora@example.test', marketingUnsubscribed: true });
    const leo = await Customer.create({ businessId: biz._id, name: 'Leo', email: 'leo@example.test' });
    const visited = await mk(rosa, -4);                        // 3.5h ago → review
    await mk(nora, -4);                                        // opted out → nothing
    const tooSoon = await mk(leo, -1.5);                       // 1h ago → not yet
    const old = await mk(leo, -24 * 50);                       // 50 days ago, once → due back
    const unpaid = await mk(leo, -5, { status: 'confirmed' }); // never marked as attended → no review

    sent.length = 0;
    await runReviewRequests(now);
    await waitForEmails();
    const reviews = sent.filter((e) => e.source === 'booking.followup_review');
    assert.deepEqual(reviews.map((e) => e.to[0]), ['rosa@example.test']);
    assert.match(reviews[0].html, /g\.page\/r\/test\/review/);
    assert.match(reviews[0].html, /public\/unsubscribe\?token=/, 'every follow-up carries the opt-out');
    assert.ok((await Booking.findById(visited._id)).reviewRequestedAt);
    assert.equal((await Booking.findById(tooSoon._id)).reviewRequestedAt, null);
    assert.equal((await Booking.findById(unpaid._id)).reviewRequestedAt, null);
    sent.length = 0;
    await Promise.all([runReviewRequests(now), runReviewRequests(now)]);
    assert.equal(sent.filter((e) => e.source === 'booking.followup_review').length, 0, 'never twice');

    // "Te toca volver": Leo's last attended visit... he came 1.5h ago, so not due. Drop that one.
    await Booking.deleteMany({ _id: { $in: [tooSoon._id, unpaid._id] } });
    const tenAm = new Date(now); // make sure it is after 10:00 in Madrid for the daily run
    const madridHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (madridHour < 10) tenAm.setUTCHours(tenAm.getUTCHours() + (10 - madridHour));
    sent.length = 0;
    await runRebookReminders(tenAm);
    await waitForEmails();
    const rebooks = sent.filter((e) => e.source === 'booking.followup_rebook');
    assert.deepEqual(rebooks.map((e) => e.to[0]), ['leo@example.test']);
    assert.match(rebooks[0].html, /Reservar cita/);
    assert.ok((await Booking.findById(old._id)).rebookReminderSentAt);
    sent.length = 0;
    await runRebookReminders(tenAm);
    assert.equal(sent.length, 0, 'once a day and once per visit');

    // Opt-out link works and stops everything
    const token = (await Customer.findById(leo._id)).unsubscribeToken;
    assert.ok(token);
    res = await request(app).get(`/api/marketing/public/unsubscribe?token=${token}`);
    assert.equal(res.status, 200);
    assert.equal((await Customer.findById(leo._id)).marketingUnsubscribed, true);

    // Confirmation emails now mention the follow-ups and how to refuse them
    sent.length = 0;
    res = await request(app).post('/api/bookings').set(as('owner')).send({
      date: nextTuesday(42), time: '10:00', items: [{ serviceId: ids.corte }], guestName: 'Nueva', guestEmail: 'nueva@example.test', guestPhone: '611000222', source: 'phone',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await waitForEmails();
    const confirmation = sent.find((e) => e.source === 'booking.confirmed');
    assert.ok(confirmation, 'confirmation sent');
    assert.match(confirmation.html, /date de baja aquí/);

    await request(app).put('/api/bookings/follow-ups').set(as('owner')).send({ rebook: { enabled: false }, review: { enabled: false } });
  });

  test('agenda: move an appointment to another time, services and professional', async () => {
    const d = nextTuesday(49);
    let res = await request(app).post('/api/bookings').set(as('staff')).send({
      date: d, time: '17:00', items: [{ serviceId: ids.corte, resourceId: ids.luis }], guestName: 'Mover', guestEmail: 'mover@example.test', source: 'phone',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body._id;
    const priceBefore = res.body.totalPrice;

    // Free times for this appointment ignore the appointment itself
    res = await request(app).post(`/api/bookings/${id}/reschedule-slots`).set(as('staff')).send({ from: d });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.some((s) => s.time === '17:00'), 'its own time is still offered');
    assert.ok(!res.body.some((s) => s.time === '10:00'), 'Luis does not work mornings');

    // Another appointment sits at 18:00 with Luis
    res = await request(app).post('/api/bookings').set(as('staff')).send({
      date: d, time: '18:00', items: [{ serviceId: ids.corte, resourceId: ids.luis }], guestName: 'Ocupa', source: 'phone',
    });
    assert.equal(res.status, 201);
    res = await request(app).patch(`/api/bookings/${id}/reschedule`).set(as('staff')).send({ date: d, time: '18:00' });
    assert.equal(res.status, 409, 'taken slot refused');
    assert.equal(await Occupancy.countDocuments({ bookingId: id }), 6, 'failed move keeps the old cells');

    sent.length = 0;
    res = await request(app).patch(`/api/bookings/${id}/reschedule`).set(as('staff')).send({ date: d, time: '19:00' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rescheduleCount, 1);
    assert.equal(res.body.totalPrice, priceBefore);
    assert.equal(res.body.reminderSentAt, null);
    await waitForEmails();
    const moved = sent.find((e) => e.source === 'booking.rescheduled');
    assert.ok(moved, 'customer told about the change');
    assert.match(moved.subject, /Cita cambiada/);
    assert.match(moved.html, /Antes era el/);

    // The old time is free again for someone else
    res = await request(app).post('/api/bookings').set(as('staff')).send({
      date: d, time: '17:00', items: [{ serviceId: ids.corte, resourceId: ids.luis }], guestName: 'Hueco', source: 'phone',
    });
    assert.equal(res.status, 201, 'old slot released');

    // Change services and professional: corte + tinte with Ana in the morning
    sent.length = 0;
    res = await request(app).patch(`/api/bookings/${id}/reschedule`).set(as('staff')).send({
      date: d, time: '10:00', notify: false,
      items: [{ serviceId: ids.corte, resourceId: ids.ana }, { serviceId: ids.tinte, resourceId: ids.ana }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.segments.length, 2);
    assert.equal(res.body.totalPrice, 1800 + 4500, 'price follows the new services');
    assert.deepEqual(res.body.segments[0].resourceIds, [ids.ana]);
    await waitForEmails();
    assert.ok(!sent.some((e) => e.source === 'booking.rescheduled'), 'notify: false');

    // Charged appointments are not moved
    res = await request(app).post(`/api/bookings/${id}/checkout`).set(as('owner')).send({ method: 'cash' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await request(app).patch(`/api/bookings/${id}/reschedule`).set(as('staff')).send({ date: d, time: '12:00' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'ALREADY_PAID');
  });

  test('customer changes or cancels from the link, within the business policy', async () => {
    const d = nextTuesday(35);
    let res = await request(app).get('/api/bookings/policy').set(as('staff'));
    assert.deepEqual(res.body, { changeMinHours: 0, allowReschedule: true, note: '' });
    res = await request(app).put('/api/bookings/policy').set(as('staff')).send({ changeMinHours: 24 });
    assert.equal(res.status, 403, 'managers only');
    res = await request(app).put('/api/bookings/policy').set(as('owner')).send({ changeMinHours: 5 });
    assert.equal(res.status, 400);
    res = await request(app).put('/api/bookings/policy').set(as('owner')).send({ changeMinHours: 24, note: 'Avisa con un día de antelación.' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const cat = await request(app).get(`/api/bookings/public/${biz._id}/catalog`);
    assert.equal(cat.body.policy.changeMinHours, 24);
    assert.equal(cat.body.policy.note, 'Avisa con un día de antelación.');

    res = await request(app).post(`/api/bookings/public/${biz._id}/bookings`).send({
      date: d, time: '17:00', items: [{ serviceId: ids.corte }],
      guestName: 'Paula', guestPhone: '644555666', guestEmail: 'paula@example.test', consent: true,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const auth = { bookingId: res.body.id, token: res.body.token };

    res = await request(app).get(`/api/bookings/public/cancel?bookingId=${auth.bookingId}&token=${auth.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.canReschedule, true);
    assert.equal(res.body.canCancel, true);
    assert.equal(res.body.business.name, 'Peluquería Test');
    assert.equal(res.body.policy.changeMinHours, 24);

    res = await request(app).post('/api/bookings/public/reschedule/slots').send({ ...auth, from: d });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const six = res.body.find((s) => s.time === '18:00');
    assert.ok(six);
    assert.ok(!('resourceIds' in (res.body[0] || {})));

    res = await request(app).post('/api/bookings/public/reschedule').send({ ...auth, date: d, time: '18:00', token: 'y'.repeat(48) });
    assert.equal(res.status, 404, 'wrong token');

    sent.length = 0;
    res = await request(app).post('/api/bookings/public/reschedule').send({ ...auth, date: d, time: '18:00' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(new Date(res.body.start).toISOString(), new Date(six.start).toISOString());
    await waitForEmails();
    assert.ok(sent.some((e) => e.source === 'booking.rescheduled' && e.to[0] === 'paula@example.test'));
    assert.ok(sent.some((e) => e.source === 'booking.staff_rescheduled' && /Antes era el/.test(e.html)));

    // Inside the notice window: no more online changes
    const Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    await Booking.updateOne({ _id: auth.bookingId }, { $set: { start: new Date(Date.now() + 5 * 3600000), end: new Date(Date.now() + 5.5 * 3600000) } });
    res = await request(app).get(`/api/bookings/public/cancel?bookingId=${auth.bookingId}&token=${auth.token}`);
    assert.equal(res.body.canCancel, false);
    assert.equal(res.body.reason, 'too_late');
    res = await request(app).post('/api/bookings/public/cancel').send(auth);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TOO_LATE');
    res = await request(app).post('/api/bookings/public/reschedule').send({ ...auth, date: d, time: '19:00' });
    assert.equal(res.body.code, 'TOO_LATE');

    await request(app).put('/api/bookings/policy').set(as('owner')).send({ changeMinHours: 0, note: '' });
  });
});
