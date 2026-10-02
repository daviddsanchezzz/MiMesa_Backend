const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');

describe('professional access lifecycle', { skip: !process.env.MONGO_TEST_URI && 'set MONGO_TEST_URI to run database tests' }, () => {
  let app, mongoose, Business, Member, Resource, business, other, professional, member;
  const as = (user) => ({ 'x-test-user': user });
  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGO_TEST_URI, { dbName: `vetra_professional_access_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require('../../core/models/Business');
    Member = require('../../core/models/BusinessMember');
    Resource = require('../../modules/bookings/models/Resource');
    const config = { businessType: 'appointments', plan: 'pro', subscriptionStatus: 'active' };
    business = await Business.create({ ...config, name: 'Equipo test', email: 'team@example.test' });
    other = await Business.create({ ...config, name: 'Otro negocio', email: 'other@example.test' });
    for (const role of ['owner', 'manager', 'staff']) {
      addUser({ id: role });
      const m = await Member.create({ userId: role, role, businessId: business._id });
      if (role === 'staff') member = m;
    }
    addUser({ id: 'other-owner' });
    await Member.create({ userId: 'other-owner', role: 'owner', businessId: other._id });
  });
  after(async () => {
    if (mongoose?.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('professional can exist without a login, with services and a schedule', async () => {
    const created = await request(app).post('/api/bookings/resources').set(as('owner')).send({ kind: 'staff', name: 'Marina', color: '#7c3aed' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    professional = created.body;
    assert.ok(!professional.userId);
    const service = await request(app).post('/api/bookings/services').set(as('owner')).send({ name: 'Manicura', durationMin: 30, price: { amount: 25 }, requirements: [{ kind: 'staff', quantity: 1 }] });
    assert.equal(service.status, 201, JSON.stringify(service.body));
    assert.equal((await request(app).put(`/api/bookings/resources/${professional._id}/services`).set(as('owner')).send({ serviceIds: [service.body._id] })).status, 200);
    assert.equal((await request(app).put('/api/bookings/schedule').set(as('owner')).send({ ownerType: 'resource', ownerId: professional._id, rules: [{ days: [1, 2], start: '09:00', end: '14:00' }], overrides: [] })).status, 200);
  });

  test('staff cannot read team finances, change roles or invite; managers cannot revoke', async () => {
    assert.equal((await request(app).get('/api/bookings/team?from=2026-10-01&to=2026-10-02').set(as('staff'))).status, 403);
    assert.equal((await request(app).put(`/api/bookings/team/${professional._id}/pay`).set(as('staff')).send({ type: 'monthly', amount: 1200 })).status, 403);
    assert.equal((await request(app).put(`/api/members/${member._id}`).set(as('staff')).send({ role: 'owner' })).status, 403);
    assert.equal((await request(app).post('/api/invitations').set(as('staff')).send({ name: 'Ana', email: 'ana@example.test', role: 'staff' })).status, 403);
    assert.equal((await request(app).delete(`/api/members/${member._id}`).set(as('manager'))).status, 403);
  });

  test('revoking access preserves the professional and isolates other businesses', async () => {
    assert.equal((await request(app).put(`/api/bookings/resources/${professional._id}`).set(as('owner')).send({ userId: 'staff' })).status, 200);
    const elsewhere = await Resource.create({ businessId: other._id, kind: 'staff', name: 'Otra agenda', userId: 'staff' });
    assert.equal((await request(app).delete(`/api/members/${member._id}`).set(as('other-owner'))).status, 404);
    assert.equal((await request(app).delete(`/api/members/${member._id}`).set(as('owner'))).status, 200);
    const kept = await Resource.findById(professional._id).lean();
    assert.equal(kept.name, 'Marina');
    assert.equal(kept.active, true);
    assert.equal(kept.userId, null);
    assert.equal((await Resource.findById(elsewhere._id).lean()).userId, 'staff');
    assert.equal(await Member.countDocuments({ _id: member._id }), 0);
    assert.equal((await request(app).get('/api/bookings/resources').set(as('staff'))).status, 403);
    const schedule = await request(app).get(`/api/bookings/schedule?ownerType=resource&ownerId=${professional._id}`).set(as('owner'));
    assert.equal(schedule.body.rules.length, 1);
  });

  test('the owner cannot be removed', async () => {
    const owner = await Member.findOne({ userId: 'owner', businessId: business._id });
    assert.equal((await request(app).delete(`/api/members/${owner._id}`).set(as('owner'))).status, 400);
  });
});
