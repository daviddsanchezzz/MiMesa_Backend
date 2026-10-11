/**
 * Packs ("bonos"): who can use one and for what, the state of a sold pack and
 * the validation of what the team enters. Pure. Money in cents.
 */
const { BookingError } = require('./errors');

const METHODS = ['cash', 'card', 'bizum', 'other'];
const MAX = 10_000_00;
const DAY = 24 * 60 * 60 * 1000;
const bad = (msg) => { throw new BookingError(400, msg, 'BAD_REQUEST'); };
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function int(value, label, { min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${label} no es válido`);
  return n;
}

/** What the manager enters to create or edit a pack in the catalogue. */
function packInput(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) bad('Ponle un nombre al bono');
  if (name.length > 80) bad('El nombre es demasiado largo');
  const serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds.map(String) : [];
  if (serviceIds.length > 100 || serviceIds.some((id) => !OBJECT_ID.test(id))) bad('Los servicios no son válidos');
  return {
    name,
    sessions: int(body.sessions, 'El número de sesiones', { min: 2, max: 200 }),
    price: int(body.price, 'El precio', { min: 0, max: MAX }),
    serviceIds: [...new Set(serviceIds)],
    validityDays: body.validityDays === null || body.validityDays === '' || body.validityDays === undefined ? null : int(body.validityDays, 'La validez', { min: 1, max: 1825 }),
    active: body.active === undefined ? true : Boolean(body.active),
  };
}

/** The sale of a pack to a customer: the pack's price unless the team changes it. */
function buildSale(pack, body = {}, { now = new Date(), localDate, userId = null } = {}) {
  if (!pack.active) bad('Este bono ya no se vende');
  if (!METHODS.includes(body.method)) bad('Elige cómo ha pagado');
  const amount = body.price === undefined || body.price === null || body.price === '' ? pack.price : int(body.price, 'El precio', { min: 0, max: MAX });
  return {
    packId: pack._id,
    name: pack.name,
    sessions: pack.sessions,
    remaining: pack.sessions,
    serviceIds: pack.serviceIds || [],
    soldAt: now,
    expiresAt: pack.validityDays ? new Date(now.getTime() + pack.validityDays * DAY) : null,
    payment: { method: body.method, amount, date: localDate, paidAt: now, paidBy: userId, note: String(body.note || '').slice(0, 300) },
  };
}

/** 'active' | 'used_up' | 'expired' */
function packStatus(sold, now = new Date()) {
  if (sold.remaining <= 0) return 'used_up';
  if (sold.expiresAt && new Date(sold.expiresAt) <= now) return 'expired';
  return 'active';
}

/** Every service of the appointment must be covered by the pack (empty list = any service). */
function coversBooking(sold, booking) {
  const allowed = new Set((sold.serviceIds || []).map(String));
  if (!allowed.size) return true;
  return (booking.segments || []).length > 0 && booking.segments.every((s) => allowed.has(String(s.serviceId)));
}

module.exports = { packInput, buildSale, packStatus, coversBooking, METHODS };
