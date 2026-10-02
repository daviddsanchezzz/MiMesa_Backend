const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { lib } = require('../helpers/load');

const tz = lib('timezone');
const phone = lib('phoneMatching');
const { pickFields } = lib('pickFields');
const { escapeHtml } = lib('escapeHtml');
const { acquireLock } = lib('keyedLock');

describe('timezone', () => {
  test('validates IANA zones', () => {
    assert.equal(tz.isValidTimezone('Europe/Madrid'), true);
    assert.equal(tz.isValidTimezone('Mars/Olympus'), false);
    assert.equal(tz.isValidTimezone(''), false);
    assert.equal(tz.businessTimezone({ timezone: 'nope' }), 'Europe/Madrid');
    assert.equal(tz.businessTimezone({ timezone: 'America/Mexico_City' }), 'America/Mexico_City');
  });

  test('wall-clock Madrid time to UTC, summer and winter', () => {
    assert.equal(tz.zonedDateTimeToUtc('2026-07-15', '21:00', 'Europe/Madrid').toISOString(), '2026-07-15T19:00:00.000Z');
    assert.equal(tz.zonedDateTimeToUtc('2026-01-15', '21:00', 'Europe/Madrid').toISOString(), '2026-01-15T20:00:00.000Z');
  });

  test('handles DST change days', () => {
    // 2026-03-29: clocks jump 02:00 -> 03:00 in Madrid
    assert.equal(tz.zonedDateTimeToUtc('2026-03-29', '12:00', 'Europe/Madrid').toISOString(), '2026-03-29T10:00:00.000Z');
    // 2026-10-25: clocks go back 03:00 -> 02:00
    assert.equal(tz.zonedDateTimeToUtc('2026-10-25', '12:00', 'Europe/Madrid').toISOString(), '2026-10-25T11:00:00.000Z');
  });

  test('date as seen in a timezone', () => {
    const lateUtc = new Date('2026-07-15T23:30:00Z');
    assert.equal(tz.dateInTimezone(lateUtc, 'Europe/Madrid'), '2026-07-16');
    assert.equal(tz.dateInTimezone(lateUtc, 'America/New_York'), '2026-07-15');
  });
});

describe('phoneMatching', () => {
  test('stores Spanish numbers without country code', () => {
    assert.equal(phone.toStoredNormalizedPhone('+34 612 345 678'), '612345678');
    assert.equal(phone.toStoredNormalizedPhone('0034612345678'), '612345678');
    assert.equal(phone.toStoredNormalizedPhone('612-34-56-78'), '612345678');
    assert.equal(phone.toStoredNormalizedPhone(''), '');
    assert.equal(phone.toStoredNormalizedPhone('+33 6 12 34 56 78'), '33612345678');
  });

  test('match candidates cover every Spanish spelling', () => {
    const c = phone.getPhoneMatchCandidates('612345678');
    for (const v of ['612345678', '34612345678', '0034612345678']) assert.ok(c.includes(v), v);
    const intl = phone.getPhoneMatchCandidates('+34612345678');
    assert.ok(intl.includes('612345678'));
    assert.deepEqual(phone.getPhoneMatchCandidates(null), []);
  });
});

describe('small helpers', () => {
  test('pickFields keeps only allowed own keys', () => {
    assert.deepEqual(pickFields({ a: 1, b: 2, c: 3 }, ['a', 'c', 'z']), { a: 1, c: 3 });
    assert.deepEqual(pickFields(null, ['a']), {});
    assert.deepEqual(pickFields(Object.create({ a: 1 }), ['a']), {});
  });

  test('escapeHtml neutralizes markup', () => {
    const out = escapeHtml('<script>"x" & \'y\'</script>');
    assert.ok(!out.includes('<') && !out.includes('>'));
    assert.ok(out.includes('&amp;'));
  });

  test('keyedLock serializes work per key', async () => {
    const order = [];
    const job = async (key, label, ms) => {
      const release = await acquireLock(key);
      order.push(`start ${label}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${label}`);
      release();
    };
    await Promise.all([job('k', 'A', 20), job('k', 'B', 1), job('other', 'C', 1)]);
    assert.ok(order.indexOf('end A') < order.indexOf('start B'), order.join(', '));
    assert.ok(order.indexOf('start C') < order.indexOf('end A'), 'different keys run in parallel');
  });
});
