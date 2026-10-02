/**
 * Floor plan: tables keep any angle in steps of 15°, can be created already
 * placed, booths exist, and each room stores its drawn elements (walls, bar,
 * entrance…) — never another business's, never unknown kinds.
 * Skipped unless MONGO_TEST_URI is set.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('floor plan', { skip }, () => {
  let app, mongoose, Business, BusinessMember;
  const as = (user) => ({ 'x-test-user': user });

  async function restaurant(key) {
    const b = await Business.create({ name: `Rest ${key}`, email: `${key}@example.test`, plan: 'pro', subscriptionStatus: 'active', businessType: 'restaurant' });
    addUser({ id: key });
    await BusinessMember.create({ userId: key, businessId: b._id, role: 'owner', userEmail: `${key}@example.test` });
    return b;
  }

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_floor_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    await restaurant('fp1');
    await restaurant('fp2');
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('angles round to 15° steps and tables can be created already placed', async () => {
    const { _normalizeAngle } = require(path.join(ROOT, 'verticals/restaurant/controllers/tableController'));
    assert.equal(_normalizeAngle(44), 45);
    assert.equal(_normalizeAngle(-15), 345);
    assert.equal(_normalizeAngle(360), 0);
    assert.equal(_normalizeAngle('x'), 0);

    const created = await request(app).post('/api/tables').set(as('fp1'))
      .send({ name: 'B1', capacity: 6, shape: 'booth', angle: 45, x: 120.4, y: 80 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.shape, 'booth');
    assert.equal(created.body.angle, 45);
    assert.equal(created.body.x, 120);
    assert.equal(created.body.y, 80);

    const moved = await request(app).put(`/api/tables/${created.body._id}`).set(as('fp1')).send({ angle: 100, x: 300, y: null });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.angle, 105);
    assert.equal(moved.body.x, 300);
    assert.equal(moved.body.y, null);
  });

  test('rooms keep their elements, clean them and stay private', async () => {
    const room = await request(app).post('/api/rooms').set(as('fp1')).send({ name: 'Sala', capacity: 40 });
    assert.equal(room.status, 201);
    assert.deepEqual(room.body.elements, []);

    const saved = await request(app).put(`/api/rooms/${room.body._id}`).set(as('fp1')).send({
      elements: [
        { kind: 'bar', x: 10.6, y: 20, w: 240, h: 56, angle: 370, label: 'Barra' },
        { kind: 'spaceship', x: 0, y: 0 },
        { kind: 'wall', x: 0, y: 0, w: 1, h: 99999 },
      ],
      businessId: '000000000000000000000000',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.elements.length, 2, 'unknown kinds are dropped');
    assert.deepEqual(
      saved.body.elements.map(({ kind, x, w, h, angle, label }) => ({ kind, x, w, h, angle, label })),
      [{ kind: 'bar', x: 11, w: 240, h: 56, angle: 10, label: 'Barra' }, { kind: 'wall', x: 0, w: 4, h: 4000, angle: 0, label: '' }],
    );
    const list = await request(app).get('/api/rooms').set(as('fp1'));
    assert.equal(list.body[0].elements.length, 2);
    assert.equal(String(list.body[0].businessId), String((await Business.findOne({ email: 'fp1@example.test' }))._id), 'businessId cannot be changed');

    const other = await request(app).put(`/api/rooms/${room.body._id}`).set(as('fp2')).send({ elements: [] });
    assert.equal(other.status, 404);
  });
});
