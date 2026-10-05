const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { snapshotRow, diffSchedules, describeChanges } = load('modules/staff/lib/scheduleDiff');
const { cleanTimeOff, coversShift, overlapsOther, describe: describeOff } = load('modules/staff/lib/timeOff');
const { whyCannotTake, overlap } = load('modules/staff/lib/swaps');
const { buildNoticeEmail } = load('modules/staff/services/staffNotifications');
const { fmtRangeEs } = load('modules/staff/lib/dates');

const row = (id, employeeId, date, start, end, extra = {}) => ({ assignmentId: id, employeeId, date, start, end, shiftName: 'Comida', roleLabel: '', notes: '', ...extra });

describe('snapshotRow', () => {
  test('uses the staff hours of the shift unless the assignment has its own', () => {
    const shift = { _id: 's1', name: 'Comida', startTime: '13:00', endTime: '16:00', staffStartTime: '12:30', staffEndTime: '17:00' };
    const r = snapshotRow({ _id: 'a1', employeeId: 'e1', date: '2026-10-05', shift, startTime: '', endTime: '' });
    assert.deepEqual([r.start, r.end, r.shiftName, r.shiftId], ['12:30', '17:00', 'Comida', 's1']);
    assert.equal(snapshotRow({ _id: 'a2', employeeId: 'e1', date: '2026-10-05', shift, startTime: '14:00', endTime: '16:00' }).start, '14:00');
  });
});

describe('diffSchedules', () => {
  const prev = [row('a1', 'e1', '2026-10-05', '13:00', '17:00'), row('a2', 'e2', '2026-10-05', '13:00', '17:00'), row('a3', 'e1', '2026-10-06', '20:00', '00:00')];
  test('no changes, no one to warn', () => {
    assert.equal(diffSchedules(prev, [...prev]).total, 0);
  });
  test('only the people affected appear', () => {
    const next = [
      row('a1', 'e1', '2026-10-05', '12:00', '17:00'),     // changed
      row('a2', 'e2', '2026-10-05', '13:00', '17:00'),     // same
      row('a4', 'e3', '2026-10-07', '13:00', '17:00'),     // new
    ];                                                       // a3 removed
    const d = diffSchedules(prev, next);
    assert.equal(d.total, 3);
    assert.deepEqual(Object.keys(d.byEmployee).sort(), ['e1', 'e3']);
    assert.equal(d.byEmployee.e1.changed.length, 1);
    assert.equal(d.byEmployee.e1.removed.length, 1);
    assert.equal(d.byEmployee.e3.added.length, 1);
  });
  test('a shift that changes hands is removed from one and added to the other', () => {
    const d = diffSchedules(prev, prev.map((r) => (r.assignmentId === 'a1' ? { ...r, employeeId: 'e2' } : r)));
    assert.equal(d.byEmployee.e1.removed.length, 1);
    assert.equal(d.byEmployee.e2.added.length, 1);
  });
  test('texts for the notice', () => {
    const d = diffSchedules([], prev.slice(0, 1));
    assert.deepEqual(describeChanges(d.byEmployee.e1, { first: true }), ['lun 5 · 13:00–17:00 (Comida)']);
    const d2 = diffSchedules(prev.slice(0, 1), [row('a1', 'e1', '2026-10-05', '12:00', '17:00')]);
    assert.match(describeChanges(d2.byEmployee.e1)[0], /^Cambia: lun 5 · 13:00–17:00.* → lun 5 · 12:00–17:00/);
  });
});

describe('time off', () => {
  test('validation', () => {
    assert.ok(cleanTimeOff({ type: 'nope', from: '2026-10-05' }).error);
    assert.ok(cleanTimeOff({ type: 'vacation', from: '2026-10-05', to: '2026-10-01' }).error);
    assert.ok(cleanTimeOff({ type: 'unavailable', from: '2026-10-05', to: '2026-10-06', fromTime: '18:00' }).error, 'hours only for a single day');
    const ok = cleanTimeOff({ type: 'day_off', from: '2026-10-05', note: ' me caso ' });
    assert.deepEqual(ok.value, { type: 'day_off', from: '2026-10-05', to: '2026-10-05', fromTime: '', toTime: '', note: 'me caso' });
  });
  test('a whole-day absence covers every shift, a partial one only the hours it names', () => {
    const day = { from: '2026-10-05', to: '2026-10-07', fromTime: '', toTime: '' };
    assert.equal(coversShift(day, '2026-10-06', '13:00', '17:00'), true);
    assert.equal(coversShift(day, '2026-10-08', '13:00', '17:00'), false);
    const evening = { from: '2026-10-05', to: '2026-10-05', fromTime: '18:00', toTime: '' };
    assert.equal(coversShift(evening, '2026-10-05', '13:00', '17:00'), false);
    assert.equal(coversShift(evening, '2026-10-05', '20:00', '01:00'), true);
  });
  test('overlapping periods of the same person', () => {
    const a = { from: '2026-10-05', to: '2026-10-09', fromTime: '', toTime: '' };
    assert.equal(overlapsOther(a, { from: '2026-10-09', to: '2026-10-12', fromTime: '', toTime: '' }), true);
    assert.equal(overlapsOther(a, { from: '2026-10-10', to: '2026-10-12', fromTime: '', toTime: '' }), false);
    const x = { from: '2026-10-05', to: '2026-10-05', fromTime: '10:00', toTime: '12:00' };
    assert.equal(overlapsOther(x, { from: '2026-10-05', to: '2026-10-05', fromTime: '13:00', toTime: '15:00' }), false);
  });
  test('description', () => {
    assert.equal(describeOff({ type: 'vacation', from: '2026-10-05', to: '2026-10-09', fromTime: '', toTime: '' }), 'Vacaciones · 2026-10-05 → 2026-10-09');
  });
});

describe('swaps', () => {
  const shift = { date: '2026-10-05', start: '20:00', end: '01:00' };
  test('overlap handles shifts past midnight', () => {
    assert.equal(overlap({ start: '22:00', end: '02:00' }, shift), true);
    assert.equal(overlap({ start: '13:00', end: '17:00' }, shift), false);
  });
  test('the colleague must be free: no overlapping shift, no absence', () => {
    const taker = { firstName: 'Pablo', status: 'active' };
    assert.equal(whyCannotTake({ shift, taker }), null);
    assert.match(whyCannotTake({ shift, taker, takerShifts: [{ start: '19:00', end: '23:00' }] }), /ya trabaja/);
    assert.match(whyCannotTake({ shift, taker, takerTimeOff: [{ status: 'approved', from: '2026-10-05', to: '2026-10-05', fromTime: '', toTime: '' }] }), /ausencia/);
    assert.equal(whyCannotTake({ shift, taker, takerTimeOff: [{ status: 'pending', from: '2026-10-05', to: '2026-10-05', fromTime: '', toTime: '' }] }), null, 'a pending request does not block');
    assert.ok(whyCannotTake({ shift, taker: { status: 'inactive' } }));
  });
});

describe('notice email and dates', () => {
  test('escapes what people write', () => {
    const { subject, html } = buildNoticeEmail({ business: { name: 'Bar <b>' }, title: 'Ha cambiado tu horario', lines: ['Nuevo: <script>x</script>'], cta: { label: 'Ver', path: '/mi-horario' } });
    assert.match(subject, /Ha cambiado tu horario/);
    assert.ok(!html.includes('<script>x</script>'));
    assert.ok(html.includes('/mi-horario'));
  });
  test('range', () => {
    assert.equal(fmtRangeEs('2026-10-05', '2026-10-11'), '5 – 11 oct');
    assert.equal(fmtRangeEs('2026-09-28', '2026-10-04'), '28 sep – 4 oct');
  });
});
