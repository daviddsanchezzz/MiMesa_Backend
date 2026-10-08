const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../modules/site/lib/validation');
const s = require('../../modules/site/lib/schedule');
const { socialLinks } = require('../../modules/site/controllers/publicSiteController');

describe('site validation (how to book, social links)', () => {
  test('reservations, social and the whole profile', () => {
    assert.deepEqual(v.reservations({ mode: 'link', url: 'https://thefork.es/x' }), { mode: 'link', url: 'https://thefork.es/x' });
    assert.deepEqual(v.reservations({ mode: 'vetra', url: 'https://ignored' }), { mode: 'vetra', url: '' });
    assert.throws(() => v.reservations({ mode: 'link', url: '' }), /enlace/);
    assert.throws(() => v.reservations({ mode: 'otro' }), /Elige/);
    assert.throws(() => v.reservations({ mode: 'link', url: 'javascript:alert(1)' }), /http/);
    assert.equal(v.social({ instagram: '@casanita', whatsapp: '+34 699 566 291' }).instagram, '@casanita');
    assert.throws(() => v.social({ facebook: 'facebook.com/x' }), /http/);
    assert.throws(() => v.social({ instagram: 'dos palabras' }), /usuario/);
    assert.throws(() => v.social({ whatsapp: 'hola' }), /teléfono/);
    assert.deepEqual(Object.keys(v.profile({ reservations: { mode: 'none' }, openingHours: 'ignored', contactEmail: 'x' })), ['reservations']);
  });
});

describe('schedule from the turnos, vacations and closures already defined', () => {
  const lunch = { name: 'Comida', startTime: '13:00', endTime: '16:00', staffStartTime: '12:00', staffEndTime: '17:00', days: [1, 2, 3, 4, 5, 6, 0] };
  const dinner = { name: 'Cena', startTime: '20:00', endTime: '01:00', days: [1, 2, 3, 4, 5, 6] };
  const summer = { name: 'Verano', startTime: '12:00', endTime: '18:00', days: [0], startDate: '2026-07-01', endDate: '2026-08-31' };
  const data = (extra = {}) => ({ shifts: [lunch, dinner, summer], vacations: [], exceptions: [], ...extra });
  const at = (date, hhmm) => ({ date, minutes: s.toMinutes(hhmm), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() });

  test('the regular week: customer times only, turnos with dates left out, sorted', () => {
    const week = s.weeklyHours(data().shifts);
    assert.equal(week.length, 7);
    assert.deepEqual(week[2].ranges, [{ open: '13:00', close: '16:00' }, { open: '20:00', close: '01:00' }]);
    assert.deepEqual(week[0].ranges, [{ open: '13:00', close: '16:00' }]);   // Sunday: lunch only (the summer turno has dates)
    assert.ok(!JSON.stringify(week).includes('12:00')); // never the staff times
  });

  test('turnos that touch are one range, a night range is left alone', () => {
    assert.deepEqual(s.mergeRanges([{ open: '13:00', close: '16:00' }, { open: '16:00', close: '17:30' }, { open: '20:00', close: '01:00' }]),
      [{ open: '13:00', close: '17:30' }, { open: '20:00', close: '01:00' }]);
  });

  test('seasonal turnos: the ones with dates that have not ended', () => {
    assert.deepEqual(s.seasonalShifts(data().shifts, '2026-06-01').map((x) => [x.name, x.from, x.to]), [['Verano', '2026-07-01', '2026-08-31']]);
    assert.deepEqual(s.seasonalShifts(data().shifts, '2026-09-15'), []);
  });

  test('a day: its turnos, plus the seasonal one on its dates', () => {
    assert.deepEqual(s.dayOf(data(), '2026-10-06', 2).ranges.map((r) => r.open), ['13:00', '20:00']);
    // Sunday in July: lunch 13–16 merges with the summer service 12–18
    assert.deepEqual(s.dayOf(data(), '2026-07-05', 0).ranges, [{ open: '12:00', close: '18:00' }]);
  });

  test('a vacation closes the day and gives its reason', () => {
    const d = data({ vacations: [{ startDate: '2026-08-10', endDate: '2026-08-24', reason: 'Vacaciones de verano' }] });
    assert.deepEqual(s.dayOf(d, '2026-08-12', 3), { ranges: [], reason: 'Vacaciones de verano' });
    assert.equal(s.dayOf(d, '2026-08-25', 2).ranges.length, 2);
  });

  test('a closure exception closes one turno or the whole day', () => {
    const one = data({ exceptions: [{ date: '2026-10-06', shiftName: 'Cena', type: 'closed', message: 'Evento privado' }] });
    assert.deepEqual(s.dayOf(one, '2026-10-06', 2).ranges, [{ open: '13:00', close: '16:00' }]);
    const all = data({ exceptions: [{ date: '2026-10-06', shiftName: '__all__', type: 'closed', message: 'Cerrado por obras' }] });
    assert.deepEqual(s.dayOf(all, '2026-10-06', 2), { ranges: [], reason: 'Cerrado por obras' });
    // a "full" or "call" exception does not close the restaurant
    const full = data({ exceptions: [{ date: '2026-10-06', shiftName: 'Cena', type: 'full' }] });
    assert.equal(s.dayOf(full, '2026-10-06', 2).ranges.length, 2);
  });

  test('open now: inside a turno, between turnos, and after midnight from the night before', () => {
    assert.equal(s.isOpenNow(data(), at('2026-10-06', '14:00')), true);
    assert.equal(s.isOpenNow(data(), at('2026-10-06', '17:00')), false);
    assert.equal(s.isOpenNow(data(), at('2026-10-07', '00:30')), true);    // Tuesday dinner until 01:00
    assert.equal(s.isOpenNow(data(), at('2026-10-07', '01:30')), false);
    assert.equal(s.isOpenNow(data(), at('2026-10-05', '00:30')), false);   // Monday early: Sunday has no dinner
  });

  test('a closed dinner does not keep the place open past midnight', () => {
    const d = data({ exceptions: [{ date: '2026-10-06', shiftName: 'Cena', type: 'closed' }] });
    assert.equal(s.isOpenNow(d, at('2026-10-07', '00:30')), false);
  });

  test('upcoming closures: vacations and closure exceptions, soonest first, within the horizon', () => {
    const d = {
      vacations: [{ startDate: '2026-08-10', endDate: '2026-08-24', reason: 'Verano' }, { startDate: '2025-01-01', endDate: '2025-01-05', reason: 'Pasada' }],
      exceptions: [{ date: '2026-07-20', shiftName: 'Cena', type: 'closed', message: 'Boda' }, { date: '2026-07-25', shiftName: '__all__', type: 'closed' }, { date: '2026-07-26', shiftName: 'Cena', type: 'full' }],
    };
    const list = s.upcomingClosures(d, '2026-07-01');
    assert.deepEqual(list.map((c) => [c.from, c.shift]), [['2026-07-20', 'Cena'], ['2026-07-25', null], ['2026-08-10', null]]);
  });

  test('local time in the restaurant timezone, and the whole view', () => {
    const now = s.localNow(new Date('2026-10-06T21:30:00Z'), 'Europe/Madrid'); // CEST = UTC+2
    assert.deepEqual(now, { date: '2026-10-06', minutes: 23 * 60 + 30, weekday: 2 });
    const out = s.build(data(), now);
    assert.equal(out.today.openNow, true);
    assert.equal(out.today.closed, false);
    assert.equal(out.openingHours.length, 7);
  });
});

describe('google reviews', () => {
  test('rating and count together, decimal comma accepted, or nothing', () => {
    assert.deepEqual(v.reviews({ rating: '4,6', count: '1.234', url: 'https://g.page/r/abc' }), { rating: 4.6, count: 1234, url: 'https://g.page/r/abc' });
    assert.deepEqual(v.reviews({ rating: 5, count: 3 }), { rating: 5, count: 3, url: '' });
    assert.deepEqual(v.reviews({ rating: '', count: '' }), { rating: null, count: null, url: '' });
    assert.throws(() => v.reviews({ rating: 4.5 }), /valoración y cuántas/);
    assert.throws(() => v.reviews({ rating: 6, count: 10 }), /0 a 5/);
    assert.throws(() => v.reviews({ rating: 4, count: 2.5 }), /reseñas/);
    assert.throws(() => v.reviews({ rating: 4, count: 10, url: 'javascript:x' }), /http/);
    assert.equal(v.reviews(undefined), undefined);
    assert.ok('reviews' in v.profile({ reviews: { rating: 4, count: 1 } }));
  });
});

describe('social links', () => {
  test('handles and phones become links', () => {
    const links = socialLinks({ instagram: '@casanita', tiktok: 'casanita', facebook: 'https://facebook.com/casanita', whatsapp: '699566291' });
    assert.deepEqual(links.map((l) => [l.type, l.url]), [
      ['instagram', 'https://www.instagram.com/casanita'],
      ['facebook', 'https://facebook.com/casanita'],
      ['tiktok', 'https://www.tiktok.com/@casanita'],
      ['whatsapp', 'https://wa.me/34699566291'],
    ]);
    assert.deepEqual(socialLinks({}), []);
  });
});
