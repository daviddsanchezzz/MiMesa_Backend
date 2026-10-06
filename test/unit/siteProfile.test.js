const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../modules/site/lib/validation');
const h = require('../../modules/site/lib/hours');
const { socialLinks } = require('../../modules/site/controllers/publicSiteController');

describe('site validation', () => {
  test('opening hours: 7 days, ranges sorted, night ranges allowed', () => {
    const out = v.openingHours([
      { day: 5, ranges: [{ open: '20:00', close: '01:00' }, { open: '13:00', close: '16:00' }] },
      { day: 1, ranges: [] },
    ]);
    assert.equal(out.length, 7);
    assert.deepEqual(out[5].ranges, [{ open: '13:00', close: '16:00' }, { open: '20:00', close: '01:00' }]);
    assert.deepEqual(out[0].ranges, []);
    assert.equal(v.openingHours(undefined), undefined);
  });

  test('refuses bad hours, repeated days and too many ranges', () => {
    assert.throws(() => v.openingHours([{ day: 8, ranges: [] }]), /Día/);
    assert.throws(() => v.openingHours([{ day: 1, ranges: [] }, { day: 1, ranges: [] }]), /repetido/);
    assert.throws(() => v.openingHours([{ day: 1, ranges: [{ open: '9:00', close: '12:00' }] }]), /HH:MM/);
    assert.throws(() => v.openingHours([{ day: 1, ranges: [{ open: '12:00', close: '12:00' }] }]), /misma/);
    assert.throws(() => v.openingHours([{ day: 1, ranges: Array.from({ length: 4 }, (_, i) => ({ open: `0${i + 1}:00`, close: `0${i + 1}:30` })) }]), /franjas/);
  });

  test('closures: valid dates, ordered, end not before start', () => {
    const out = v.closures([{ from: '2026-08-10', to: '2026-08-20', reason: ' Vacaciones ' }, { from: '2026-05-01', to: '2026-05-01' }]);
    assert.deepEqual(out.map((c) => c.from), ['2026-05-01', '2026-08-10']);
    assert.equal(out[1].reason, 'Vacaciones');
    assert.throws(() => v.closures([{ from: '2026-08-20', to: '2026-08-10' }]), /antes/);
    assert.throws(() => v.closures([{ from: '20/08/2026', to: '2026-08-21' }]), /fecha/);
  });

  test('reservations, social and email', () => {
    assert.deepEqual(v.reservations({ mode: 'link', url: 'https://thefork.es/x' }), { mode: 'link', url: 'https://thefork.es/x' });
    assert.deepEqual(v.reservations({ mode: 'vetra', url: 'https://ignored' }), { mode: 'vetra', url: '' });
    assert.throws(() => v.reservations({ mode: 'link', url: '' }), /enlace/);
    assert.throws(() => v.reservations({ mode: 'otro' }), /Elige/);
    assert.throws(() => v.reservations({ mode: 'link', url: 'javascript:alert(1)' }), /http/);
    assert.equal(v.social({ instagram: '@casanita', whatsapp: '+34 699 566 291' }).instagram, '@casanita');
    assert.throws(() => v.social({ facebook: 'facebook.com/x' }), /http/);
    assert.throws(() => v.social({ instagram: 'dos palabras' }), /usuario/);
    assert.equal(v.profile({ contactEmail: ' Hola@Casanita.COM ' }).contactEmail, 'hola@casanita.com');
    assert.throws(() => v.profile({ contactEmail: 'no-es-email' }), /email/);
  });
});

describe('opening hours on the website', () => {
  const week = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, ranges: day === 0 ? [] : [{ open: '13:00', close: '16:00' }, { open: '20:00', close: '01:00' }] }));
  const at = (date, hhmm, weekday) => ({ date, minutes: h.toMinutes(hhmm), weekday });

  test('open inside a range, closed outside and on a day without ranges', () => {
    assert.equal(h.isOpenNow(week, [], at('2026-10-06', '14:00', 2)), true);    // Tuesday lunch
    assert.equal(h.isOpenNow(week, [], at('2026-10-06', '17:00', 2)), false);   // between services
    assert.equal(h.isOpenNow(week, [], at('2026-10-04', '14:00', 0)), false);   // Sunday: closed
  });

  test('a night range that ends after midnight keeps the place open the next early morning', () => {
    assert.equal(h.isOpenNow(week, [], at('2026-10-07', '00:30', 3)), true);    // Tuesday dinner until 01:00
    assert.equal(h.isOpenNow(week, [], at('2026-10-07', '01:30', 3)), false);
    // Saturday night spills into Sunday, and Sunday itself is closed
    assert.equal(h.isOpenNow(week, [], at('2026-10-04', '00:30', 0)), true);
    assert.equal(h.isOpenNow(week, [], at('2026-10-05', '00:30', 1)), false);
  });

  test('a closure closes the day, and also the spill of the night before', () => {
    const closures = [{ from: '2026-10-06', to: '2026-10-06', reason: 'Evento privado' }];
    assert.equal(h.isOpenNow(week, closures, at('2026-10-06', '14:00', 2)), false);
    // the dinner of the closed Tuesday did not happen, so there is no spill into Wednesday's early hours
    assert.equal(h.isOpenNow(week, closures, at('2026-10-07', '00:30', 3)), false);
    // while a normal day's dinner does spill
    assert.equal(h.isOpenNow(week, [], at('2026-10-07', '00:30', 3)), true);
    assert.equal(h.closureOn(closures, '2026-10-06').reason, 'Evento privado');
    assert.equal(h.closureOn(closures, '2026-10-07'), null);
  });

  test('"24:00" runs to the end of the day', () => {
    const late = [{ day: 2, ranges: [{ open: '20:00', close: '24:00' }] }];
    assert.equal(h.isOpenNow(late, [], at('2026-10-06', '23:59', 2)), true);
  });

  test('upcoming closures: not ended yet, soonest first, within the horizon', () => {
    const closures = [
      { from: '2026-01-01', to: '2026-01-02' },
      { from: '2026-12-24', to: '2026-12-26' },
      { from: '2026-10-10', to: '2026-10-12' },
      { from: '2028-01-01', to: '2028-01-02' },
    ];
    assert.deepEqual(h.upcomingClosures(closures, '2026-10-06', 120).map((c) => c.from), ['2026-10-10', '2026-12-24']);
  });

  test('local time in the restaurant timezone', () => {
    const n = h.localNow(new Date('2026-10-06T21:30:00Z'), 'Europe/Madrid'); // CEST = UTC+2
    assert.deepEqual(n, { date: '2026-10-06', minutes: 23 * 60 + 30, weekday: 2 });
    const next = h.localNow(new Date('2026-10-06T22:30:00Z'), 'Europe/Madrid');
    assert.equal(next.date, '2026-10-07');
    assert.equal(next.weekday, 3);
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
