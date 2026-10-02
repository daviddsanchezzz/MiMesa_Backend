const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const sched = load('modules/bookings/lib/schedule');
const { createContext, evaluateStart, findSlots } = load('modules/bookings/lib/availability');
const { cellsFor, isAligned } = load('modules/bookings/lib/occupancy');

const TZ = 'Europe/Madrid';
const TUE = '2026-10-13'; // martes, horario de verano (UTC+2)
const SAT = '2026-10-17';
const SUN = '2026-10-18';
const NOW = new Date('2026-10-01T08:00:00Z');

const utc = (s) => new Date(s);
const times = (slots, date) => slots.filter((s) => !date || s.date === date).map((s) => s.time);

const salonHours = {
  rules: [
    { days: [2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
    { days: [2, 3, 4, 5], start: '16:00', end: '20:00' },
  ],
  overrides: [],
};
const ana = { _id: 'ana', kind: 'staff', name: 'Ana', capacity: 1, sortOrder: 1 };
const luis = { _id: 'luis', kind: 'staff', name: 'Luis', capacity: 1, sortOrder: 2 };
const corte = {
  _id: 'corte', durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, slotIntervalMin: 30,
  bookingMode: 'slot', capacityMode: 'resource', partySize: { min: 1, max: 1 },
  requirements: [{ kind: 'staff', count: 1, resourceIds: [], customerCanChoose: true }],
  onlineBooking: { enabled: true, minNoticeHours: 2, maxDaysAhead: 60 },
};

function ctx(overrides = {}) {
  return createContext({
    service: corte, timezone: TZ, businessSchedule: salonHours, resources: [ana, luis], now: NOW, ...overrides,
  });
}

describe('schedule windows', () => {
  test('weekly rules by weekday', () => {
    assert.deepEqual(sched.windowsForDate(salonHours, TUE), [[540, 840], [960, 1200]]);
    assert.deepEqual(sched.windowsForDate(salonHours, SAT), [[540, 840]]);
    assert.deepEqual(sched.windowsForDate(salonHours, SUN), []);
  });

  test('overrides: closed range, special hours, last one wins', () => {
    const s = {
      ...salonHours,
      overrides: [
        { from: '2026-08-01', to: '2026-08-31', closed: true },
        { from: TUE, to: TUE, windows: [{ start: '10:00', end: '12:00' }] },
        { from: SAT, to: SAT, closed: true },
        { from: SAT, to: SAT, windows: [{ start: '09:00', end: '11:00' }] },
      ],
    };
    assert.deepEqual(sched.windowsForDate(s, '2026-08-11'), []);
    assert.deepEqual(sched.windowsForDate(s, TUE), [[600, 720]]);
    assert.deepEqual(sched.windowsForDate(s, SAT), [[540, 660]]);
  });

  test('overlapping rules are merged; intersect works', () => {
    const s = { rules: [{ days: [2], start: '09:00', end: '12:00' }, { days: [2], start: '11:00', end: '13:00' }] };
    assert.deepEqual(sched.windowsForDate(s, TUE), [[540, 780]]);
    assert.deepEqual(sched.intersect([[540, 840], [960, 1200]], [[600, 1000]]), [[600, 840], [960, 1000]]);
  });

  test('no schedule means closed', () => {
    assert.deepEqual(sched.windowsForDate(null, TUE), []);
  });
});

describe('salon: one professional per appointment', () => {
  test('slots follow opening hours on the service grid', () => {
    const slots = findSlots(ctx(), { from: TUE, to: TUE });
    assert.equal(slots[0].time, '09:00');
    assert.equal(times(slots).at(-1), '19:30');
    assert.ok(!times(slots).includes('14:00'), 'lunch break');
    assert.equal(slots.length, 10 + 8);
    // stored in UTC: 09:00 Madrid in October = 07:00Z
    assert.equal(slots[0].start.toISOString(), '2026-10-13T07:00:00.000Z');
    assert.equal(slots[0].end.toISOString(), '2026-10-13T07:30:00.000Z');
  });

  test('"any professional" takes the first free one; busy Ana → Luis', () => {
    const c = ctx({ busy: [{ resourceId: 'ana', start: utc('2026-10-13T07:00:00Z'), end: utc('2026-10-13T07:30:00Z') }] });
    const r = evaluateStart(c, TUE, 540);
    assert.equal(r.ok, true);
    assert.deepEqual(r.assignments, [['luis']]);
  });

  test('"any professional" shares out the day: the one with less booked time goes first', () => {
    // Ana already has an hour booked in the morning; Luis has nothing → Luis gets 16:00.
    const busy = [{ resourceId: 'ana', start: utc('2026-10-13T07:00:00Z'), end: utc('2026-10-13T08:00:00Z') }];
    const c = ctx({ busy });
    assert.deepEqual(evaluateStart(c, TUE, 960).assignments, [['luis']]);
    // Luis now has more booked time than Ana → back to Ana.
    const c2 = ctx({ busy: [...busy, { resourceId: 'luis', start: utc('2026-10-13T08:00:00Z'), end: utc('2026-10-13T10:00:00Z') }] });
    assert.deepEqual(evaluateStart(c2, TUE, 960).assignments, [['ana']]);
    // Bookings on another day do not count.
    const c3 = ctx({ busy: [{ resourceId: 'ana', start: utc('2026-10-14T07:00:00Z'), end: utc('2026-10-14T10:00:00Z') }] });
    assert.deepEqual(evaluateStart(c3, TUE, 960).assignments, [['ana']]);
    // A chosen professional is always respected, even if busier.
    assert.deepEqual(evaluateStart(c, TUE, 960, { preferred: { 0: 'ana' } }).assignments, [['ana']]);
  });

  test('chosen professional who is busy → no slot', () => {
    const c = ctx({ busy: [{ resourceId: 'ana', start: utc('2026-10-13T07:00:00Z'), end: utc('2026-10-13T07:30:00Z') }] });
    const r = evaluateStart(c, TUE, 540, { preferred: { 0: 'ana' } });
    assert.deepEqual(r, { ok: false, reason: 'no_resource', requirement: 0 });
  });

  test('both busy → slot disappears from the list', () => {
    const busy = ['ana', 'luis'].map((id) => ({ resourceId: id, start: utc('2026-10-13T07:00:00Z'), end: utc('2026-10-13T08:00:00Z') }));
    const slots = findSlots(ctx({ busy }), { from: TUE, to: TUE });
    assert.ok(!times(slots).includes('09:00'));
    assert.ok(!times(slots).includes('09:30'));
    assert.ok(times(slots).includes('10:00'));
  });

  test('a professional with own shifts is only offered inside them', () => {
    const c = ctx({
      resources: [ana],
      resourceSchedules: { ana: { rules: [{ days: [2], start: '16:00', end: '18:00' }] } },
    });
    assert.deepEqual(times(findSlots(c, { from: TUE, to: TUE })), ['16:00', '16:30', '17:00', '17:30']);
  });

  test('own shift outside business hours is cut to business hours', () => {
    const c = ctx({
      resources: [ana],
      resourceSchedules: { ana: { rules: [{ days: [2], start: '19:00', end: '22:00' }] } },
    });
    assert.deepEqual(times(findSlots(c, { from: TUE, to: TUE })), ['19:00', '19:30']);
  });

  test('buffer after keeps the next slot free for cleaning', () => {
    const service = { ...corte, bufferAfterMin: 10 };
    const c = ctx({
      service,
      resources: [ana],
      busy: [{ resourceId: 'ana', start: utc('2026-10-13T07:00:00Z'), end: utc('2026-10-13T07:40:00Z') }],
    });
    // 09:30 new booking busy interval 09:30–10:10 overlaps existing 09:00–09:40
    assert.equal(evaluateStart(c, TUE, 570).ok, false);
    assert.equal(evaluateStart(c, TUE, 600).ok, true);
  });

  test('service longer than the remaining window is not offered', () => {
    const service = { ...corte, durationMin: 90, slotIntervalMin: 30 };
    const slots = times(findSlots(ctx({ service }), { from: SAT, to: SAT }));
    assert.equal(slots.at(-1), '12:30');
  });

  test('closed days give nothing', () => {
    assert.deepEqual(findSlots(ctx(), { from: SUN, to: SUN }), []);
    assert.equal(evaluateStart(ctx(), SUN, 600).reason, 'closed');
  });

  test('inactive or not-online resources are skipped online', () => {
    const c = ctx({ online: true, resources: [{ ...ana, active: false }, { ...luis, bookableOnline: false }] });
    assert.equal(evaluateStart(c, TUE, 600).reason, 'no_resource');
    const staffSide = ctx({ online: false, resources: [{ ...luis, bookableOnline: false }] });
    assert.equal(evaluateStart(staffSide, TUE, 600).ok, true);
  });
});

describe('online rules', () => {
  test('minimum notice', () => {
    const c = ctx({ online: true, now: utc('2026-10-13T07:00:00Z') }); // 09:00 Madrid
    assert.equal(evaluateStart(c, TUE, 600).reason, 'notice'); // 10:00 < 11:00
    assert.equal(evaluateStart(c, TUE, 660).ok, true);         // 11:00
  });

  test('max days ahead', () => {
    const c = ctx({ online: true, service: { ...corte, onlineBooking: { enabled: true, maxDaysAhead: 5 } } });
    assert.equal(evaluateStart(c, TUE, 600).reason, 'too_far');
  });

  test('online disabled per service', () => {
    const c = ctx({ online: true, service: { ...corte, onlineBooking: { enabled: false } } });
    assert.equal(evaluateStart(c, TUE, 600).reason, 'online_disabled');
  });

  test('staff can book without notice but not far in the past', () => {
    const c = ctx({ online: false, now: utc('2026-10-13T07:00:00Z') });
    assert.equal(evaluateStart(c, TUE, 540).ok, true);
    const later = ctx({ online: false, now: utc('2026-10-16T07:00:00Z') });
    assert.equal(evaluateStart(later, TUE, 540).reason, 'past');
  });
});

describe('restaurant: tables sized to the party', () => {
  const hours = { rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '20:00', end: '23:30' }] };
  const tables = [
    { _id: 't6', kind: 'space', capacity: 6, minCapacity: 3 },
    { _id: 't2', kind: 'space', capacity: 2 },
    { _id: 't4', kind: 'space', capacity: 4, minCapacity: 2 },
  ];
  const cena = {
    durationMin: 90, slotIntervalMin: 30, bookingMode: 'slot', capacityMode: 'resource',
    partySize: { min: 1, max: 6 },
    requirements: [{ kind: 'space', count: 1, matchPartySize: true }],
    onlineBooking: { enabled: true, maxDaysAhead: 60 },
  };
  const c = (busy = []) => createContext({ service: cena, timezone: TZ, businessSchedule: hours, resources: tables, busy, now: NOW });

  test('smallest table that fits', () => {
    assert.deepEqual(evaluateStart(c(), SAT, 1200, { partySize: 2 }).assignments, [['t2']]);
    assert.deepEqual(evaluateStart(c(), SAT, 1200, { partySize: 3 }).assignments, [['t4']]);
    assert.deepEqual(evaluateStart(c(), SAT, 1200, { partySize: 5 }).assignments, [['t6']]);
  });

  test('min capacity: a couple does not get the table for 6', () => {
    const busy = ['t2', 't4'].map((id) => ({ resourceId: id, start: utc('2026-10-17T18:00:00Z'), end: utc('2026-10-17T19:30:00Z') }));
    assert.equal(evaluateStart(c(busy), SAT, 1200, { partySize: 2 }).reason, 'no_resource');
  });

  test('party size limits', () => {
    assert.equal(evaluateStart(c(), SAT, 1200, { partySize: 7 }).reason, 'party_size');
  });

  test('last seating leaves time to finish before closing', () => {
    assert.equal(times(findSlots(c(), { from: SAT, to: SAT, partySize: 2 })).at(-1), '22:00');
  });
});

describe('restaurant: pool capacity (aforo por franja)', () => {
  const hours = { rules: [{ days: [6], start: '13:00', end: '16:00' }] };
  const menu = {
    durationMin: 60, slotIntervalMin: 60, bookingMode: 'slot', capacityMode: 'pool', poolCapacity: 10,
    partySize: { min: 1, max: 10 }, requirements: [], onlineBooking: { enabled: true, maxDaysAhead: 60 },
  };
  test('bookings add up until the pool is full', () => {
    const poolUsage = [{ start: utc('2026-10-17T11:00:00Z'), end: utc('2026-10-17T12:00:00Z'), partySize: 8 }];
    const c = createContext({ service: menu, timezone: TZ, businessSchedule: hours, poolUsage, now: NOW });
    assert.equal(evaluateStart(c, SAT, 780, { partySize: 2 }).ok, true);
    assert.equal(evaluateStart(c, SAT, 780, { partySize: 3 }).reason, 'pool_full');
    assert.equal(evaluateStart(c, SAT, 840, { partySize: 10 }).ok, true);
  });
});

describe('therapist: person + room, buffers, extra busy', () => {
  const hours = { rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '21:00' }] };
  const res = [
    { _id: 'marta', kind: 'staff', capacity: 1 },
    { _id: 'd1', kind: 'space', capacity: 1 },
  ];
  const sesion = {
    durationMin: 50, bufferAfterMin: 10, slotIntervalMin: 60, bookingMode: 'slot', capacityMode: 'resource',
    partySize: { min: 1, max: 1 },
    requirements: [{ kind: 'staff', count: 1 }, { kind: 'space', count: 1, optional: true }],
  };
  test('needs the person; the room is optional', () => {
    const busy = [{ resourceId: 'd1', start: utc('2026-10-13T15:00:00Z'), end: utc('2026-10-13T16:00:00Z') }];
    const c = createContext({ service: sesion, timezone: TZ, businessSchedule: hours, resources: res, busy, now: NOW });
    const r = evaluateStart(c, TUE, 1020); // 17:00, room busy
    assert.equal(r.ok, true);
    assert.deepEqual(r.assignments, [['marta'], []]);
    assert.deepEqual(evaluateStart(c, TUE, 1080).assignments, [['marta'], ['d1']]);
  });

  test('extraBusy blocks a resource only for that check', () => {
    const c = createContext({ service: sesion, timezone: TZ, businessSchedule: hours, resources: res, now: NOW });
    const extra = [{ resourceId: 'marta', start: utc('2026-10-13T15:00:00Z'), end: utc('2026-10-13T16:00:00Z') }];
    assert.equal(evaluateStart(c, TUE, 1020, { extraBusy: extra }).ok, false);
    assert.equal(evaluateStart(c, TUE, 1020).ok, true, 'context is left clean');
  });

  test('same resource never fills two requirements', () => {
    const svc = { ...sesion, requirements: [{ kind: 'staff', count: 2 }] };
    const c = createContext({ service: svc, timezone: TZ, businessSchedule: hours, resources: res, now: NOW });
    assert.equal(evaluateStart(c, TUE, 600).reason, 'no_resource');
  });
});

describe('carpentry: quote services are not bookable', () => {
  test('quote mode', () => {
    const c = ctx({ service: { ...corte, bookingMode: 'quote' } });
    assert.equal(evaluateStart(c, TUE, 600).reason, 'quote_only');
  });
});

describe('daylight saving time', () => {
  test('Sunday 25 Oct: 10:00 Madrid is 09:00Z (winter time)', () => {
    const hours = { rules: [{ days: [0, 1], start: '09:00', end: '12:00' }] };
    const c = ctx({ businessSchedule: hours });
    assert.equal(evaluateStart(c, '2026-10-25', 600).start.toISOString(), '2026-10-25T09:00:00.000Z');
    assert.equal(evaluateStart(c, '2026-10-18', 600).start.toISOString(), '2026-10-18T08:00:00.000Z');
  });
});

describe('occupancy cells', () => {
  test('5-minute cells, end exclusive; adjacent bookings do not collide', () => {
    const a = cellsFor(utc('2026-10-13T07:00:00Z'), utc('2026-10-13T07:30:00Z'));
    const b = cellsFor(utc('2026-10-13T07:30:00Z'), utc('2026-10-13T08:00:00Z'));
    assert.equal(a.length, 6);
    assert.equal(a[0].toISOString(), '2026-10-13T07:00:00.000Z');
    const setA = new Set(a.map((d) => d.getTime()));
    assert.ok(b.every((d) => !setA.has(d.getTime())));
    assert.equal(isAligned(15), true);
    assert.equal(isAligned(7), false);
  });
});
