/**
 * Charging an appointment (Caja). Pure: validates the input and builds the
 * payment; the service saves it. Money in cents.
 */
const { BookingError } = require('./errors');

const METHODS = ['cash', 'card', 'bizum', 'other'];
const CHARGEABLE = ['confirmed', 'checked_in', 'completed'];
const MAX = 10_000_00; // 10.000 € per ticket is plenty for a salon
const bad = (msg) => { throw new BookingError(400, msg, 'BAD_REQUEST'); };

function cents(value, label, { min = 0 } = {}) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > MAX) bad(`${label} no es válido`);
  return n;
}

function buildPayment(booking, body = {}, { now = new Date(), localDate, userId = null } = {}) {
  if (!CHARGEABLE.includes(booking.status)) bad('Esta cita no se puede cobrar');
  if (booking.payment) bad('Esta cita ya está cobrada');
  if (!METHODS.includes(body.method)) bad('Elige cómo ha pagado');
  const services = body.services === undefined ? (booking.totalPrice || 0) : cents(body.services, 'El importe');
  const extras = (Array.isArray(body.extras) ? body.extras : []).slice(0, 20).map((x, i) => {
    const name = String(x?.name || '').trim().slice(0, 100);
    if (!name) bad(`Producto ${i + 1}: falta el nombre`);
    const qty = x.qty === undefined ? 1 : Number(x.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) bad(`Producto ${i + 1}: cantidad no válida`);
    return { name, price: cents(x.price, `Producto ${i + 1}: precio`), qty };
  });
  const extrasTotal = extras.reduce((s, x) => s + x.price * x.qty, 0);
  const discount = cents(body.discount, 'El descuento');
  if (discount > services + extrasTotal) bad('El descuento es mayor que el total');
  const tip = cents(body.tip, 'La propina');
  return {
    method: body.method,
    services,
    extras,
    discount,
    tip,
    total: services + extrasTotal - discount,
    date: localDate,
    paidAt: now,
    paidBy: userId,
    note: String(body.note || '').slice(0, 300),
  };
}

/** Day totals from a list of payments. */
function tillTotals(payments) {
  const t = { cash: 0, card: 0, bizum: 0, other: 0, services: 0, extras: 0, discount: 0, tips: 0, total: 0, payments: 0 };
  for (const p of payments) {
    t[p.method] += p.total + p.tip;
    t.services += p.services;
    t.extras += (p.extras || []).reduce((s, x) => s + x.price * x.qty, 0);
    t.discount += p.discount;
    t.tips += p.tip;
    t.total += p.total;
    t.payments += 1;
  }
  return t;
}

module.exports = { buildPayment, tillTotals, METHODS, CHARGEABLE };
