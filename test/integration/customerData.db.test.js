/**
 * Customer data rights (RGPD) and what staff can see, against a real database
 * (skipped without MONGO_TEST_URI).
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

describe('customer data (RGPD) and staff visibility', { skip }, () => {
  let app, mongoose, Business, BusinessMember, Booking, Customer, Service, Resource;
  let biz;
  const as = (user) => ({ 'x-test-user': user });
  const ids = {};

  before(async () => {
    installFakeAuth();
    const delivery = require.resolve(path.join(ROOT, 'core/services/emailDelivery'));
    require(delivery);
    require.cache[delivery].exports.sendTrackedEmail = async () => ({ data: { id: 'test' } });
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_rgpd_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    Customer = require(path.join(ROOT, 'core/models/Customer'));
    Booking = require(path.join(ROOT, 'modules/bookings/models/Booking'));
    Service = require(path.join(ROOT, 'modules/bookings/models/Service'));
    Resource = require(path.join(ROOT, 'modules/bookings/models/Resource'));
    await require(path.join(ROOT, 'modules/bookings/models/Occupancy')).init();

    biz = await Business.create({ name: 'Salón RGPD', email: 'rgpd@example.test', plan: 'pro', subscriptionStatus: 'active', businessType: 'appointments', timezone: 'Europe/Madrid' });
    addUser({ id: 'owner', email: 'owner@rgpd.test' });
    addUser({ id: 'staff', email: 'staff@rgpd.test' });
    await BusinessMember.create({ userId: 'owner', businessId: biz._id, role: 'owner', userEmail: 'owner@rgpd.test' });
    await BusinessMember.create({ userId: 'staff', businessId: biz._id, role: 'staff', userEmail: 'staff@rgpd.test' });
    await request(app).put('/api/bookings/schedule').set(as('owner')).send({ rules: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '20:00' }] });
    ids.ana = (await request(app).post('/api/bookings/resources').set(as('owner')).send({ kind: 'staff', name: 'Ana' })).body._id;
    ids.corte = (await request(app).post('/api/bookings/services').set(as('owner')).send({
      name: 'Corte', durationMin: 30, requirements: [{ kind: 'staff', customerCanChoose: true }], price: { amount: 2000 },
    })).body._id;
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('staff see the day, not the money; customer list has contact fields only', async () => {
    const r = await request(app).post('/api/bookings').set(as('owner')).send({
      date: nextTuesday(), time: '10:00', items: [{ serviceId: ids.corte }], guestName: 'Lucía Pérez', guestPhone: '611223344', guestEmail: 'lucia@example.test', source: 'phone',
      notes: 'Alérgica al tinte X', internalNotes: 'Paga siempre tarde',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.booking = r.body._id;
    const lucia = await Customer.findOne({ businessId: biz._id, email: 'lucia@example.test' });
    ids.lucia = String(lucia._id);
    await Customer.updateOne({ _id: lucia._id }, { notes: 'Nota privada del negocio' });

    const owner = await request(app).get('/api/bookings/stats').set(as('owner'));
    assert.ok(owner.body.money);
    assert.ok('expectedRevenue' in owner.body.today);
    const staff = await request(app).get('/api/bookings/stats').set(as('staff'));
    assert.equal(staff.status, 200);
    assert.equal(staff.body.restricted, true);
    assert.equal(staff.body.money, null);
    assert.ok(!('expectedRevenue' in staff.body.today));
    assert.ok(staff.body.team.every((t) => !('revenue' in t)));

    const list = await request(app).get('/api/customers').set(as('staff'));
    assert.equal(list.status, 200);
    const row = list.body.find((c) => c._id === ids.lucia);
    assert.equal(row.name, 'Lucía Pérez');
    assert.equal(row.notes, undefined, 'no private notes for staff');
    const full = await request(app).get('/api/customers').set(as('owner'));
    assert.equal(full.body.find((c) => c._id === ids.lucia).notes, 'Nota privada del negocio');
    assert.equal((await request(app).get(`/api/customers/${ids.lucia}/export`).set(as('staff'))).status, 403);
  });

  test('export: everything about one customer as JSON; all customers as CSV for the owner', async () => {
    const r = await request(app).get(`/api/customers/${ids.lucia}/export`).set(as('owner'));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /datos-lucia-perez\.json/);
    assert.equal(r.body.cliente.email, 'lucia@example.test');
    assert.equal(r.body.bookings.length, 1);
    assert.equal(r.body.bookings[0].servicios[0].servicio, 'Corte');
    assert.deepEqual(r.body.bookings[0].servicios[0].con, ['Ana']);
    assert.equal(r.body.bookings[0].nota_del_cliente, 'Alérgica al tinte X');
    assert.ok(Array.isArray(r.body.reservations));

    await Customer.create({ businessId: biz._id, name: '=HYPERLINK("x")', phone: '600' });
    const csv = await request(app).get('/api/customers/export.csv').set(as('owner'));
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.text, /^﻿nombre;telefono;email/);
    assert.match(csv.text, /Lucía Pérez;611223344;lucia@example\.test;Nota privada del negocio/);
    assert.match(csv.text, /'=HYPERLINK/, 'formulas neutralized');
    assert.equal((await request(app).get('/api/customers/export.csv').set(as('staff'))).status, 403);
  });

  test('erase: refused while something is booked ahead, then anonymizes the history', async () => {
    let r = await request(app).delete(`/api/customers/${ids.lucia}`).set(as('owner'));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'HAS_UPCOMING');
    assert.match(r.body.message, /1 citas/);

    const token = (await Booking.findById(ids.booking)).publicToken;
    await request(app).patch(`/api/bookings/${ids.booking}/status`).set(as('owner')).send({ status: 'cancelled' });
    r = await request(app).delete(`/api/customers/${ids.lucia}`).set(as('owner'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.erased.bookings, 1);
    assert.equal(await Customer.countDocuments({ _id: ids.lucia }), 0);
    const b = await Booking.findById(ids.booking).lean();
    assert.equal(b.guestName, 'Cliente eliminado');
    assert.equal(b.guestPhone, '');
    assert.equal(b.guestEmail, '');
    assert.equal(b.notes, '');
    assert.equal(b.internalNotes, '');
    assert.equal(b.customerId, null);
    assert.equal(b.totalPrice, 2000, 'the business keeps its own figures');
    assert.notEqual(b.publicToken, token, 'old email links stop working');
    const link = await request(app).get(`/api/bookings/public/cancel?bookingId=${ids.booking}&token=${token}`);
    assert.equal(link.status, 404);
  });

  test('deleting the business deletes all its data', async () => {
    const r = await request(app).delete(`/api/businesses/${biz._id}`).set(as('owner'));
    assert.ok([200, 403, 404].includes(r.status));
    // ownerId is not set on this fixture: purge directly, like the endpoint does
    const { purgeBusiness } = require(path.join(ROOT, 'core/services/purgeBusiness'));
    const out = await purgeBusiness(biz._id);
    assert.ok(out.modules.bookings.Booking >= 1);
    assert.ok(out.modules.bookings.Service >= 1);
    assert.ok('restaurant' in out.modules);
    for (const M of [Booking, Service, Resource, Customer, BusinessMember]) {
      assert.equal(await M.countDocuments({ businessId: biz._id }), 0, M.modelName);
    }
    assert.equal(await Business.countDocuments({ _id: biz._id }), 0);
  });
});
