const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

const { packInput, buildSale, packStatus, coversBooking } = load('modules/bookings/lib/packs');

const NOW = new Date('2026-10-14T10:00:00Z');
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);

describe('packInput', () => {
  test('accepts a valid pack', () => {
    const p = packInput({ name: ' Bono láser x5 ', sessions: 5, price: 25000, serviceIds: [A, A], validityDays: 180 });
    assert.deepEqual(p, { name: 'Bono láser x5', sessions: 5, price: 25000, serviceIds: [A], validityDays: 180, active: true });
  });
  test('no expiry when validity is empty', () => {
    assert.equal(packInput({ name: 'x', sessions: 3, price: 0, validityDays: '' }).validityDays, null);
  });
  test('rejects bad input', () => {
    assert.throws(() => packInput({ name: '', sessions: 5, price: 100 }), /nombre/);
    assert.throws(() => packInput({ name: 'x', sessions: 1, price: 100 }), /sesiones/);
    assert.throws(() => packInput({ name: 'x', sessions: 5, price: 12.5 }), /precio/);
    assert.throws(() => packInput({ name: 'x', sessions: 5, price: 100, serviceIds: ['nope'] }), /servicios/);
    assert.throws(() => packInput({ name: 'x', sessions: 5, price: 100, validityDays: 0 }), /validez/);
  });
});

describe('buildSale', () => {
  const pack = { _id: 'p1', name: 'Bono', sessions: 5, price: 25000, serviceIds: [A], validityDays: 30, active: true };
  const ctx = { now: NOW, localDate: '2026-10-14', userId: 'u1' };
  test('uses the pack price, full sessions and the expiry date', () => {
    const s = buildSale(pack, { method: 'card' }, ctx);
    assert.equal(s.payment.amount, 25000);
    assert.equal(s.remaining, 5);
    assert.equal(s.expiresAt.toISOString(), '2026-11-13T10:00:00.000Z');
    assert.equal(s.payment.date, '2026-10-14');
  });
  test('the team can change the price; a pack without validity never expires', () => {
    const s = buildSale({ ...pack, validityDays: null }, { method: 'cash', price: 20000 }, ctx);
    assert.equal(s.payment.amount, 20000);
    assert.equal(s.expiresAt, null);
  });
  test('needs a payment method and an active pack', () => {
    assert.throws(() => buildSale(pack, {}, ctx), /cómo ha pagado/);
    assert.throws(() => buildSale({ ...pack, active: false }, { method: 'cash' }, ctx), /ya no se vende/);
  });
});

describe('packStatus and coversBooking', () => {
  test('active, used up and expired', () => {
    assert.equal(packStatus({ remaining: 2, expiresAt: null }, NOW), 'active');
    assert.equal(packStatus({ remaining: 0, expiresAt: null }, NOW), 'used_up');
    assert.equal(packStatus({ remaining: 2, expiresAt: new Date('2026-10-01') }, NOW), 'expired');
    assert.equal(packStatus({ remaining: 2, expiresAt: new Date('2026-12-01') }, NOW), 'active');
  });
  test('a pack for some services only covers appointments made of those services', () => {
    const booking = { segments: [{ serviceId: A }] };
    assert.equal(coversBooking({ serviceIds: [A] }, booking), true);
    assert.equal(coversBooking({ serviceIds: [B] }, booking), false);
    assert.equal(coversBooking({ serviceIds: [A] }, { segments: [{ serviceId: A }, { serviceId: B }] }), false);
    assert.equal(coversBooking({ serviceIds: [] }, { segments: [{ serviceId: B }] }), true, 'empty list = any service');
  });
});
