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

  test('the profile is for managers; empty at first, saved and read back', async () => {
    assert.equal((await request(app).get('/api/site').set(as('staff'))).status, 403);
    let res = await request(app).get('/api/site').set(as('owner'));
    assert.equal(res.status, 200);
    assert.equal(res.body.openingHours.length, 7);
    assert.equal(res.body.reservations.mode, 'none');
    res = await request(app).put('/api/site').set(as('owner')).send({
      openingHours: [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, ranges: day === 1 ? [] : [{ open: '13:00', close: '16:00' }, { open: '20:00', close: '24:00' }] })),
      closures: [{ from: '2099-08-01', to: '2099-08-20', reason: 'Vacaciones' }],
      reservations: { mode: 'vetra' },
      social: { instagram: '@casanita', whatsapp: '699566291' },
      contactEmail: 'hola@casanita.test',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.openingHours[1].ranges.length, 0);
    assert.equal(res.body.openingHours[2].ranges.length, 2);
    res = await request(app).put('/api/site').set(as('owner')).send({ reservations: { mode: 'link', url: 'javascript:alert(1)' } });
    assert.equal(res.status, 400);
  });

  test('the public file: hours, today, closures, how to book and links, without a session', async () => {
    const res = await request(app).get(`/api/site/public/${biz._id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.business.name, 'Casanita');
    assert.equal(res.body.business.email, 'hola@casanita.test');
    assert.equal(res.body.openingHours.length, 7);
    assert.equal(typeof res.body.today.openNow, 'boolean');
    assert.equal(res.body.closures[0].reason, 'Vacaciones');
    assert.equal(res.body.reservations.mode, 'vetra');
    assert.match(res.body.reservations.url, /^https?:\/\//);
    assert.deepEqual(res.body.links.map((l) => l.type), ['instagram', 'whatsapp']);
    assert.equal((await request(app).get('/api/site/public/64b7f0f0f0f0f0f0f0f0f0f0')).status, 404);
  });

  test('suggestion from the reservation turnos and vacations (nothing is saved)', async () => {
    const Shift = require(path.join(ROOT, 'verticals/restaurant/models/Shift'));
    const Vacation = require(path.join(ROOT, 'verticals/restaurant/models/Vacation'));
    await Shift.create({ businessId: biz._id, name: 'Comida', startTime: '13:30', endTime: '16:00', staffStartTime: '12:30', staffEndTime: '17:30', days: [1, 2, 3] });
    await Vacation.create({ businessId: biz._id, startDate: '2099-12-24', endDate: '2099-12-26', reason: 'Navidad' });
    const res = await request(app).get('/api/site/hours-suggestion').set(as('owner'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.openingHours[1].ranges, [{ open: '13:30', close: '16:00' }]);   // customer times, not the staff ones
    assert.deepEqual(res.body.openingHours[4].ranges, []);
    assert.equal(res.body.closures[0].reason, 'Navidad');
    const saved = (await request(app).get('/api/site').set(as('owner'))).body;
    assert.equal(saved.closures[0].reason, 'Vacaciones');   // untouched
  });
});
