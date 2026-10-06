/**
 * End-to-end tests (HTTP API + a real MongoDB-compatible database) of the data the restaurant's website
 * reads: opening hours, closures, how to book and social links. Skipped unless MONGO_TEST_URI is set.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('site profile (web)', { skip }, () => {
  let app, mongoose, biz;
  const as = (user) => ({ 'x-test-user': user });

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_site_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    const Business = require(path.join(ROOT, 'core/models/Business'));
    const BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    biz = await Business.create({ name: 'Casanita', email: 'c@example.test', phone: '699566291', plan: 'pro', subscriptionStatus: 'active', businessType: 'restaurant', address: 'Calle 1', timezone: 'Europe/Madrid' });
    for (const [id, role] of [['owner', 'owner'], ['staff', 'staff']]) {
      addUser({ id });
      await BusinessMember.create({ userId: id, businessId: biz._id, role });
    }
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('the profile is for managers: bookings through Vetra by default, saved and read back', async () => {
    assert.equal((await request(app).get('/api/site').set(as('staff'))).status, 403);
    let res = await request(app).get('/api/site').set(as('owner'));
    assert.equal(res.status, 200);
    assert.equal(res.body.reservations.mode, 'vetra');
    assert.equal(res.body.business.phone, '699566291');   // from the business data, not asked again
    assert.equal(res.body.schedule.openingHours.length, 7);
    res = await request(app).put('/api/site').set(as('owner')).send({
      reservations: { mode: 'link', url: 'https://www.thefork.es/casanita' },
      social: { instagram: '@casanita', whatsapp: '699566291' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reservations.mode, 'link');
    res = await request(app).put('/api/site').set(as('owner')).send({ reservations: { mode: 'link', url: 'javascript:alert(1)' } });
    assert.equal(res.status, 400);
  });

  test('the public file takes hours and closures from the turnos, vacations and closure exceptions', async () => {
    const Shift = require(path.join(ROOT, 'verticals/restaurant/models/Shift'));
    const Vacation = require(path.join(ROOT, 'verticals/restaurant/models/Vacation'));
    const Exception = require(path.join(ROOT, 'verticals/restaurant/models/Exception'));
    await Shift.create({ businessId: biz._id, name: 'Comida', startTime: '13:30', endTime: '16:00', staffStartTime: '12:30', staffEndTime: '17:30', days: [0, 1, 2, 3, 4, 5, 6] });
    await Shift.create({ businessId: biz._id, name: 'Cena', startTime: '20:00', endTime: '23:30', days: [1, 2, 3, 4, 5, 6] });
    await Vacation.create({ businessId: biz._id, startDate: '2099-08-01', endDate: '2099-08-20', reason: 'Vacaciones' });
    await Exception.create({ businessId: biz._id, date: '2099-05-01', shiftName: '__all__', type: 'closed', message: 'Día del trabajador' });
    await Exception.create({ businessId: biz._id, date: '2099-05-02', shiftName: 'Cena', type: 'full' });   // not a closure

    const res = await request(app).get(`/api/site/public/${biz._id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.business.name, 'Casanita');
    assert.equal(res.body.business.phone, '699566291');
    assert.match(res.body.business.mapsUrl, /google\.com\/maps/);
    const monday = res.body.openingHours.find((d) => d.day === 1);
    assert.deepEqual(monday.ranges, [{ open: '13:30', close: '16:00' }, { open: '20:00', close: '23:30' }]);   // customer times, not staff times
    assert.deepEqual(res.body.openingHours.find((d) => d.day === 0).ranges, [{ open: '13:30', close: '16:00' }]);
    assert.deepEqual(res.body.closures.map((c) => [c.from, c.reason]), [['2099-05-01', 'Día del trabajador'], ['2099-08-01', 'Vacaciones']]);
    assert.equal(typeof res.body.today.openNow, 'boolean');
    assert.equal(res.body.reservations.mode, 'link');
    assert.deepEqual(res.body.links.map((l) => l.type), ['instagram', 'whatsapp']);
    assert.equal((await request(app).get('/api/site/public/64b7f0f0f0f0f0f0f0f0f0f0')).status, 404);
  });
});
