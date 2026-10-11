const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { buildCalendar, escapeText, fold, utc } = load('modules/bookings/lib/ics');

describe('ics', () => {
  test('dates are UTC in iCalendar format', () => {
    assert.equal(utc(new Date('2026-10-14T09:30:00Z')), '20261014T093000Z');
  });

  test('escapes the characters that have a meaning in iCalendar', () => {
    assert.equal(escapeText('Ana, Luis; \\ nota\nlínea 2'), 'Ana\\, Luis\; \\\\ nota\\nlínea 2');
  });

  test('folds long lines at 75 bytes without breaking a character', () => {
    const folded = fold(`DESCRIPTION:${'ñ'.repeat(120)}`);
    for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `too long: ${line.length}`);
    // unfolding gives the original back
    assert.equal(folded.replace(/\r\n /g, ''), `DESCRIPTION:${'ñ'.repeat(120)}`);
  });

  test('builds a calendar with one event per appointment', () => {
    const ics = buildCalendar({
      name: 'Ana · Estética Son',
      now: new Date('2026-10-14T08:00:00Z'),
      events: [
        { uid: 'b1-s1@vetra', start: new Date('2026-10-14T09:00:00Z'), end: new Date('2026-10-14T10:00:00Z'), summary: 'María · Láser', description: 'Láser\nTel. 600', location: 'Calle Mayor 1, Madrid', status: 'confirmed' },
        { uid: 'b2-s1@vetra', start: new Date('2026-10-15T09:00:00Z'), end: new Date('2026-10-15T09:30:00Z'), summary: 'Luis · Corte', status: 'tentative' },
      ],
    });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.match(ics, /UID:b1-s1@vetra/);
    assert.match(ics, /DTSTART:20261014T090000Z/);
    assert.match(ics, /SUMMARY:María · Láser/);
    assert.match(ics, /DESCRIPTION:Láser\\nTel. 600/);
    assert.match(ics, /LOCATION:Calle Mayor 1\\, Madrid/);
    assert.match(ics, /STATUS:TENTATIVE/);
    assert.ok(!/\r\r|[^\r]\n/.test(ics), 'every line break is CRLF');
  });

  test('an empty calendar is still a valid one', () => {
    const ics = buildCalendar({ name: 'Vacío', events: [] });
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 0);
    assert.match(ics, /X-WR-CALNAME:Vacío/);
  });
});
