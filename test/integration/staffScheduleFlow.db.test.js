/**
 * End-to-end test (HTTP API + a real MongoDB-compatible database) of publishing a week, of
 * time off and of shift swaps in the restaurant staff module. Skipped unless MONGO_TEST_URI is set.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

const plusDays = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };

describe('Publishing, time off and shift swaps', { skip }, () => {
  let app, mongoose, biz, StaffEmployee, StaffAssignment, Shift;
  const as = (user) => ({ 'x-test-user': user });
  const ids = {};
  const day = plusDays(3);

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_staffflow_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    const Business = require(path.join(ROOT, 'core/models/Business'));
    const BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    StaffEmployee = require(path.join(ROOT, 'modules/staff/models/StaffEmployee'));
    StaffAssignment = require(path.join(ROOT, 'modules/staff/models/StaffAssignment'));
    Shift = require(path.join(ROOT, 'verticals/restaurant/models/Shift'));

    biz = await Business.create({ name: 'Bar Test', email: 'bar@example.test', plan: 'pro', subscriptionStatus: 'active', businessType: 'restaurant' });
    for (const [id, role] of [['boss', 'owner'], ['waiter', 'staff'], ['cook', 'staff']]) {
      addUser({ id });
      ids[id] = (await BusinessMember.create({ userId: id, businessId: biz._id, role }))._id;
    }
    ids.marta = (await StaffEmployee.create({ businessId: biz._id, firstName: 'Marta', memberId: ids.waiter }))._id;
    ids.pablo = (await StaffEmployee.create({ businessId: biz._id, firstName: 'Pablo', memberId: ids.cook }))._id;
    ids.shift = (await Shift.create({ businessId: biz._id, name: 'Comida', startTime: '13:00', endTime: '16:00', staffStartTime: '12:30', staffEndTime: '17:00' }))._id;
    ids.assignment = (await StaffAssignment.create({ businessId: biz._id, employeeId: ids.marta, date: day, shiftId: ids.shift }))._id;
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('employees see nothing until the week is published, then the staff hours', async () => {
    let res = await request(app).get(`/api/staff/me/schedule?weekStart=${day}`).set(as('waiter'));
    assert.equal(res.body.published, false);
    assert.equal(res.body.shiftCount, 0);

    res = await request(app).get(`/api/staff/schedule/status?weekStart=${day}`).set(as('boss'));
    assert.equal(res.body.published, false);
    assert.equal(res.body.changes, 1);

    assert.equal((await request(app).post('/api/staff/schedule/publish').set(as('waiter')).send({ weekStart: day })).status, 403, 'staff cannot publish');
    res = await request(app).post('/api/staff/schedule/publish').set(as('boss')).send({ weekStart: day, notify: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    res = await request(app).get(`/api/staff/me/schedule?weekStart=${day}`).set(as('waiter'));
    assert.equal(res.body.published, true);
    assert.equal(res.body.shiftCount, 1);
    const shift = res.body.days.find((d) => d.date === day).shifts[0];
    assert.equal(shift.start, '12:30');
    assert.equal(shift.end, '17:00');

    // an edit stays in the draft until it is published
    await StaffAssignment.updateOne({ _id: ids.assignment }, { notes: 'Mesa 4' });
    res = await request(app).get(`/api/staff/schedule/status?weekStart=${day}`).set(as('boss'));
    assert.equal(res.body.changes, 1);
    res = await request(app).get(`/api/staff/me/schedule?weekStart=${day}`).set(as('waiter'));
    assert.equal(res.body.days.find((d) => d.date === day).shifts[0].notes, '');
    await request(app).post('/api/staff/schedule/publish').set(as('boss')).send({ weekStart: day, notify: false });
    res = await request(app).get(`/api/staff/me/schedule?weekStart=${day}`).set(as('waiter'));
    assert.equal(res.body.days.find((d) => d.date === day).shifts[0].notes, 'Mesa 4');
  });

  test('time off: requested, approved, and the planner warns before assigning', async () => {
    const off = plusDays(10);
    let res = await request(app).post('/api/staff/me/time-off').set(as('cook')).send({ type: 'day_off', from: off, note: 'Boda' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'pending');
    const id = res.body.id;
    assert.equal((await request(app).post('/api/staff/me/time-off').set(as('cook')).send({ type: 'vacation', from: off })).status, 409, 'overlap');

    res = await request(app).get('/api/staff/time-off?status=pending').set(as('boss'));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].employeeName, 'Pablo');
    assert.equal((await request(app).get('/api/staff/time-off').set(as('cook'))).status, 403);

    // pending does not block yet
    res = await request(app).post('/api/staff/assignments').set(as('boss')).send({ employeeId: String(ids.pablo), date: off, shiftId: String(ids.shift) });
    assert.equal(res.status, 201);
    await StaffAssignment.deleteOne({ _id: res.body._id });

    res = await request(app).patch(`/api/staff/time-off/${id}/decision`).set(as('boss')).send({ status: 'approved' });
    assert.equal(res.body.status, 'approved');
    assert.equal((await request(app).patch(`/api/staff/time-off/${id}/decision`).set(as('boss')).send({ status: 'rejected' })).status, 409, 'already decided');

    res = await request(app).post('/api/staff/assignments').set(as('boss')).send({ employeeId: String(ids.pablo), date: off, shiftId: String(ids.shift) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'TIME_OFF');
    res = await request(app).post('/api/staff/assignments').set(as('boss')).send({ employeeId: String(ids.pablo), date: off, shiftId: String(ids.shift), force: true });
    assert.equal(res.status, 201);

    res = await request(app).get(`/api/staff/assignments?weekStart=${off}`).set(as('boss'));
    assert.equal(res.body.timeOff.length, 1);
  });

  test('a shift swap needs the colleague and then the manager', async () => {
    // the other days are not Pablo's: make sure he is free on `day`
    let res = await request(app).get(`/api/staff/me/swaps/colleagues?assignmentId=${ids.assignment}`).set(as('waiter'));
    assert.equal(res.status, 200);
    assert.equal(res.body.items.find((p) => p.name === 'Pablo').blockedReason, null);

    res = await request(app).post('/api/staff/me/swaps').set(as('waiter')).send({ assignmentId: String(ids.assignment), toEmployeeId: String(ids.pablo), note: 'Médico' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.id;
    assert.equal((await request(app).post('/api/staff/me/swaps').set(as('waiter')).send({ assignmentId: String(ids.assignment) })).status, 409, 'one open request per shift');

    res = await request(app).get('/api/staff/me/swaps').set(as('cook'));
    assert.equal(res.body.incoming.length, 1);
    assert.equal((await request(app).post(`/api/staff/me/swaps/${id}/accept`).set(as('waiter'))).status, 403, 'not for the requester');
    res = await request(app).post(`/api/staff/me/swaps/${id}/accept`).set(as('cook'));
    assert.equal(res.body.status, 'pending_manager');

    // still Marta's until the manager says yes
    assert.equal(String((await StaffAssignment.findById(ids.assignment)).employeeId), String(ids.marta));
    res = await request(app).get('/api/staff/swaps').set(as('boss'));
    assert.equal(res.body.items.length, 1);

    res = await request(app).patch(`/api/staff/swaps/${id}/decision`).set(as('boss')).send({ status: 'approved' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(String((await StaffAssignment.findById(ids.assignment)).employeeId), String(ids.pablo));

    res = await request(app).get(`/api/staff/me/schedule?weekStart=${day}`).set(as('cook'));
    assert.equal(res.body.days.find((d) => d.date === day).shifts.length, 1, 'the published week follows the swap');
    res = await request(app).get(`/api/staff/me/schedule?weekStart=${day}`).set(as('waiter'));
    assert.equal(res.body.days.find((d) => d.date === day).shifts.length, 0);
  });
});
