const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const v = load('modules/bookings/lib/validation');

const throws400 = (fn, re) => assert.throws(fn, (e) => e.status === 400 && (!re || re.test(e.message)));

describe('bookings input validation', () => {
  test('service: durations and buffers in 5-minute steps', () => {
    assert.equal(v.serviceInput({ name: 'Corte', durationMin: 30 }).durationMin, 30);
    throws400(() => v.serviceInput({ name: 'Corte', durationMin: 32 }), /múltiplo de 5/);
    throws400(() => v.serviceInput({ name: 'Corte', durationMin: 30, bufferAfterMin: 7 }), /múltiplo de 5/);
    throws400(() => v.serviceInput({ name: 'Corte' }), /duración/);
    throws400(() => v.serviceInput({ durationMin: 30 }), /nombre/);
  });

  test('service: unknown fields are dropped', () => {
    const out = v.serviceInput({ name: 'X', durationMin: 30, businessId: 'hack', _id: 'x', active: true });
    assert.equal(out.businessId, undefined);
    assert.equal(out._id, undefined);
    assert.equal(out.active, true);
  });

  test('service consistency: resource mode needs a mandatory resource; pool needs capacity', () => {
    throws400(() => v.checkServiceConsistency({ requirements: [] }), /recurso obligatorio/);
    throws400(() => v.checkServiceConsistency({ requirements: [{ kind: 'space', optional: true }] }), /recurso obligatorio/);
    v.checkServiceConsistency({ requirements: [{ kind: 'staff' }] });
    throws400(() => v.checkServiceConsistency({ capacityMode: 'pool' }), /aforo/);
    v.checkServiceConsistency({ capacityMode: 'pool', poolCapacity: 10, partySize: { min: 1, max: 10 } });
    throws400(() => v.checkServiceConsistency({ capacityMode: 'pool', poolCapacity: 4, partySize: { min: 1, max: 6 } }), /supera el aforo/);
    v.checkServiceConsistency({ bookingMode: 'quote' });
  });

  test('schedule: valid rules and overrides, rejects broken ones', () => {
    const out = v.scheduleInput({
      rules: [{ days: [2, 2, 3], start: '09:00', end: '14:00' }],
      overrides: [{ from: '2026-12-25', closed: true }, { from: '2026-12-24', windows: [{ start: '09:00', end: '13:00' }] }],
    });
    assert.deepEqual(out.rules[0].days, [2, 3]);
    assert.equal(out.overrides[0].to, '2026-12-25');
    throws400(() => v.scheduleInput({ rules: [{ days: [7], start: '09:00', end: '10:00' }] }), /días/);
    throws400(() => v.scheduleInput({ rules: [{ days: [1], start: '10:00', end: '09:00' }] }), /tramo/);
    throws400(() => v.scheduleInput({ rules: [{ days: [1], start: '09:07', end: '10:00' }] }), /múltiplo de 5/);
    throws400(() => v.scheduleInput({ overrides: [{ from: '2026-12-24' }] }), /cerrado o sus horas/);
    assert.deepEqual(v.scheduleInput({ rules: [{ days: [5], start: '20:00', end: '24:00' }] }).rules[0].end, '24:00');
  });

  test('booking: online requires phone and email; staff does not', () => {
    const base = { date: '2026-10-13', time: '10:00', items: [{ serviceId: '64b000000000000000000001' }], guestName: 'Ana' };
    throws400(() => v.bookingInput(base, { online: true }), /teléfono/);
    const staff = v.bookingInput(base, { online: false });
    assert.equal(staff.partySize, 1);
    assert.equal(staff.items[0].resourceId, null);
    throws400(() => v.bookingInput({ ...base, time: '25:00' }, { online: false }), /hora/);
    throws400(() => v.bookingInput({ ...base, items: [] }, { online: false }), /servicios/);
    throws400(() => v.bookingInput({ ...base, items: [{ serviceId: 'nope' }] }, { online: false }));
    throws400(() => v.bookingInput({ ...base, guestEmail: 'x@' }, { online: false }), /email/);
  });

  test('guests cannot write internal notes', () => {
    const out = v.bookingInput({
      date: '2026-10-13', time: '10:00', items: [{ serviceId: '64b000000000000000000001' }],
      guestName: 'Ana', guestPhone: '600', guestEmail: 'a@b.es', internalNotes: 'VIP',
    }, { online: true });
    assert.equal(out.internalNotes, '');
  });

  test('date ranges are bounded', () => {
    assert.deepEqual(v.dateRange({ from: '2026-10-01' }, { maxDays: 31 }), { from: '2026-10-01', to: '2026-10-01' });
    throws400(() => v.dateRange({ from: '2026-10-01', to: '2026-12-31' }, { maxDays: 31 }), /rango máximo/);
    throws400(() => v.dateRange({ from: '2026-10-05', to: '2026-10-01' }, { maxDays: 31 }), /anterior/);
    throws400(() => v.dateRange({ from: '2026-13-45' }, { maxDays: 31 }), /fecha/);
  });
});
