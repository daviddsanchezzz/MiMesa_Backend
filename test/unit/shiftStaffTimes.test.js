const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { staffTimesOf } = load('modules/staff/lib/shiftTimes');
const { buildMySchedule } = load('modules/staff/lib/mySchedule');

describe('staff hours of a shift', () => {
  test('default to the customer hours', () => {
    assert.deepEqual(staffTimesOf({ startTime: '13:00', endTime: '16:00' }), { start: '13:00', end: '16:00' });
    assert.deepEqual(staffTimesOf({ startTime: '13:00', endTime: '16:00', staffStartTime: '', staffEndTime: '' }), { start: '13:00', end: '16:00' });
  });
  test('staff arrive earlier and leave later when set', () => {
    assert.deepEqual(staffTimesOf({ startTime: '13:00', endTime: '16:00', staffStartTime: '12:15', staffEndTime: '17:00' }), { start: '12:15', end: '17:00' });
  });
  test('Mi horario shows the staff hours and counts them', () => {
    const shift = { name: 'Comida', startTime: '13:00', endTime: '16:00', staffStartTime: '12:00', staffEndTime: '17:00' };
    const r = buildMySchedule({
      employeeId: 'e1', date: '2026-10-14',
      employees: [{ _id: 'e1', firstName: 'Marta', status: 'active' }],
      assignments: [{ _id: 'a1', employeeId: 'e1', date: '2026-10-14', shiftId: 's1', shift, startTime: '', endTime: '' }],
    });
    const s = r.days.find((d) => d.date === '2026-10-14').shifts[0];
    assert.equal(s.start, '12:00');
    assert.equal(s.end, '17:00');
    assert.equal(s.minutes, 300);
  });
  test('an hour set on the assignment still wins', () => {
    const shift = { startTime: '13:00', endTime: '16:00', staffStartTime: '12:00', staffEndTime: '17:00' };
    const r = buildMySchedule({ employeeId: 'e1', date: '2026-10-14', employees: [{ _id: 'e1', firstName: 'M', status: 'active' }],
      assignments: [{ _id: 'a1', employeeId: 'e1', date: '2026-10-14', shift, startTime: '14:00', endTime: '16:00' }] });
    assert.equal(r.days.find((d) => d.date === '2026-10-14').shifts[0].start, '14:00');
  });
});
