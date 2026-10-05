/**
 * End-to-end test (HTTP API + a real MongoDB-compatible database) of linking an employee of
 * Personal to a user of the team and of "Mi horario". Skipped unless MONGO_TEST_URI is set.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('Mi horario (employee ↔ user link)', { skip }, () => {
  let app, mongoose, biz, StaffEmployee, StaffAssignment, BusinessMember;
  const as = (user) => ({ 'x-test-user': user });
  const ids = {};
  const today = new Date().toISOString().slice(0, 10);

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_staffme_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    const Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    StaffEmployee = require(path.join(ROOT, 'modules/staff/models/StaffEmployee'));
    StaffAssignment = require(path.join(ROOT, 'modules/staff/models/StaffAssignment'));

    biz = await Business.create({ name: 'Bar Test', email: 'bar@example.test', plan: 'pro', subscriptionStatus: 'active', businessType: 'restaurant' });
    for (const [id, role] of [['boss', 'owner'], ['waiter', 'staff'], ['cook', 'staff']]) {
      addUser({ id });
      ids[id] = (await BusinessMember.create({ userId: id, businessId: biz._id, role }))._id;
    }
    ids.marta = (await StaffEmployee.create({ businessId: biz._id, firstName: 'Marta', lastName: 'García' }))._id;
    ids.pablo = (await StaffEmployee.create({ businessId: biz._id, firstName: 'Pablo' }))._id;
    await StaffAssignment.create({ businessId: biz._id, employeeId: ids.marta, date: today, startTime: '13:00', endTime: '17:00', roleLabel: 'Sala' });
    await StaffAssignment.create({ businessId: biz._id, employeeId: ids.pablo, date: today, startTime: '12:00', endTime: '16:00' });
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('not linked: nothing to show, and the planner stays closed to staff', async () => {
    let res = await request(app).get('/api/staff/me/schedule').set(as('waiter'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.linked, false);
    assert.equal((await request(app).get('/api/staff/employees').set(as('waiter'))).status, 403);
    assert.equal((await request(app).put(`/api/staff/employees/${ids.marta}/link`).set(as('waiter')).send({ memberId: String(ids.waiter) })).status, 403);
  });

  test('the owner links the waiter to Marta; she sees only her own shifts and who works with her', async () => {
    let res = await request(app).put(`/api/staff/employees/${ids.marta}/link`).set(as('boss')).send({ memberId: String(ids.waiter) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await request(app).put(`/api/staff/employees/${ids.marta}/link`).set(as('boss')).send({ memberId: String(ids.cook) })).status, 409, 'one user per employee');
    assert.equal((await request(app).put(`/api/staff/employees/${ids.pablo}/link`).set(as('boss')).send({ memberId: String(ids.waiter) })).status, 409, 'one employee per user');

    res = await request(app).get('/api/staff/me/schedule').set(as('waiter'));
    assert.equal(res.body.linked, true);
    assert.equal(res.body.published, false, 'a draft week is not shown to employees');
    assert.equal(res.body.shiftCount, 0);
    res = await request(app).post('/api/staff/schedule/publish').set(as('boss')).send({ weekStart: today, notify: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await request(app).get('/api/staff/me/schedule').set(as('waiter'));
    assert.equal(res.body.published, true);
    assert.equal(res.body.employee.name, 'Marta García');
    const day = res.body.days.find((d) => d.date === today);
    assert.equal(day.shifts.length, 1);
    assert.equal(day.shifts[0].start, '13:00');
    assert.equal(day.shifts[0].roleLabel, 'Sala');
    assert.deepEqual(day.shifts[0].coworkers, ['Pablo']);
    assert.equal(res.body.shiftCount, 1);
    assert.ok(!JSON.stringify(res.body).includes('customPrice'), 'no pay data leaves the planner');

    res = await request(app).get('/api/auth/me').set(as('waiter'));
    assert.equal(res.body.professionalId, String(ids.marta));
    assert.equal((await request(app).get('/api/staff/me/schedule?weekStart=nope').set(as('waiter'))).status, 400);
  });

  test('unlinking keeps the user in the team but takes the schedule away', async () => {
    let res = await request(app).delete(`/api/staff/employees/${ids.marta}/link`).set(as('boss'));
    assert.equal(res.status, 200);
    res = await request(app).get('/api/staff/me/schedule').set(as('waiter'));
    assert.equal(res.body.linked, false);
    assert.ok(await BusinessMember.exists({ userId: 'waiter', businessId: biz._id }), 'still in the team');
  });
});
