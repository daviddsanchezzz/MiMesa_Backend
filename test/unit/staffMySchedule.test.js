const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { buildMySchedule, weekOf, minutesBetween, shortName } = load('modules/staff/lib/mySchedule');

const employees = [
  { _id: 'e1', firstName: 'Marta', lastName: 'García', status: 'active' },
  { _id: 'e2', firstName: 'Pablo', lastName: '', status: 'active' },
  { _id: 'e3', firstName: 'Lucía', lastName: 'Ruiz', status: 'active' },
  { _id: 'e4', firstName: 'Baja', lastName: 'Antigua', status: 'inactive' },
];
// Wednesday 14 Oct 2026 → week 12–18 Oct
const a = (id, employeeId, date, startTime, endTime, extra = {}) => ({ _id: id, employeeId, date, startTime, endTime, shiftId: null, ...extra });

describe('weekOf', () => {
  test('Monday to Sunday, from any day of the week', () => {
    const w = weekOf('2026-10-14');
    assert.equal(w[0], '2026-10-12');
    assert.equal(w[6], '2026-10-18');
    assert.deepEqual(weekOf('2026-10-18'), w, 'Sunday belongs to the week that ends on it');
    assert.deepEqual(weekOf('2026-10-12'), w);
  });
});

describe('minutesBetween and shortName', () => {
  test('a shift past midnight counts the night', () => {
    assert.equal(minutesBetween('13:00', '17:00'), 240);
    assert.equal(minutesBetween('20:00', '01:00'), 300);
    assert.equal(minutesBetween('', '17:00'), 0);
  });
  test('first name and the initial of the surname', () => {
    assert.equal(shortName(employees[0]), 'Marta G.');
    assert.equal(shortName(employees[1]), 'Pablo');
  });
});

describe('buildMySchedule', () => {
  const assignments = [
    a('1', 'e1', '2026-10-14', '13:00', '17:00', { roleLabel: 'Sala', notes: 'Cumpleaños mesa 4' }),
    a('2', 'e2', '2026-10-14', '12:00', '16:00'),
    a('3', 'e3', '2026-10-14', '20:00', '23:00'),
    a('4', 'e4', '2026-10-14', '13:00', '17:00'),
    a('5', 'e1', '2026-10-16', '20:00', '01:00'),
    a('6', 'e2', '2026-10-21', '13:00', '17:00'), // next week
  ];
  const week = buildMySchedule({ employeeId: 'e1', date: '2026-10-14', assignments, employees });

  test('only my shifts, in the right days', () => {
    assert.equal(week.weekStart, '2026-10-12');
    assert.equal(week.days.length, 7);
    assert.deepEqual(week.days.map((d) => d.shifts.length), [0, 0, 1, 0, 1, 0, 0]);
    assert.equal(week.shiftCount, 2);
  });
  test('hours of the week, including the night shift', () => {
    assert.equal(week.totalMinutes, 240 + 300);
  });
  test('who else is working at the same time (names only, no former staff)', () => {
    const wednesday = week.days[2].shifts[0];
    assert.deepEqual(wednesday.coworkers, ['Pablo']);
    assert.equal(wednesday.roleLabel, 'Sala');
    assert.equal(wednesday.notes, 'Cumpleaños mesa 4');
    assert.equal(wednesday.minutes, 240);
  });
  test('the same shift counts even when the times differ, and another service does not', () => {
    const shifted = buildMySchedule({
      employeeId: 'e1', date: '2026-10-14', employees,
      assignments: [
        a('1', 'e1', '2026-10-14', '', '', { shiftId: 's1', shift: { name: 'Comida', startTime: '13:00', endTime: '16:00' } }),
        a('2', 'e3', '2026-10-14', '', '', { shiftId: 's1', shift: { name: 'Comida', startTime: '13:00', endTime: '16:00' } }),
        a('3', 'e2', '2026-10-14', '20:00', '23:00'),
      ],
    });
    const shift = shifted.days[2].shifts[0];
    assert.equal(shift.shiftName, 'Comida');
    assert.equal(shift.start, '13:00');
    assert.deepEqual(shift.coworkers, ['Lucía R.']);
  });
  test('an empty week is fine', () => {
    const empty = buildMySchedule({ employeeId: 'e3', date: '2026-11-02', assignments, employees });
    assert.equal(empty.shiftCount, 0);
    assert.equal(empty.totalMinutes, 0);
  });
});
