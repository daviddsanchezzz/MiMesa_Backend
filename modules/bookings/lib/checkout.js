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

/**
 * `pack` ({ id, name }) = the services were paid with a session of the customer's pack: only
 * products and tip are charged, and the method is only needed when there is something to charge.
 */
function buildPayment(booking, body = {}, { now = new Date(), localDate, userId = null, pack = null } = {}) {
  if (!CHARGEABLE.includes(booking.status)) bad('Esta cita no se puede cobrar');
  if (booking.payment) bad('Esta cita ya está cobrada');
  const services = pack ? 0 : (body.services === undefined ? (booking.totalPrice || 0) : cents(body.services, 'El importe'));
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
  const chargesSomething = !pack || extrasTotal - discount > 0 || tip > 0;
  if (chargesSomething && !METHODS.includes(body.method)) bad('Elige cómo ha pagado');
  return {
    method: chargesSomething ? body.method : 'pack',
    ...(pack ? { packUse: { customerPackId: pack.id, name: pack.name } } : {}),
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

/**
 * Day totals from a list of payments and the packs sold that day ({ method, amount }).
 * A pack sale is money in the till; a session spent from a pack is not.
 */
function tillTotals(payments, packSales = []) {
  const t = { cash: 0, card: 0, bizum: 0, other: 0, services: 0, extras: 0, discount: 0, tips: 0, total: 0, payments: 0, packSales: 0, packSessions: 0 };
  for (const s of packSales) {
    t[s.method] += s.amount;
    t.packSales += s.amount;
  }
  for (const p of payments) {
    if (p.method !== 'pack') t[p.method] += p.total + p.tip;
    if (p.packUse) t.packSessions += 1;
    t.services += p.services;
    t.extras += (p.extras || []).reduce((s, x) => s + x.price * x.qty, 0);
    t.discount += p.discount;
    t.tips += p.tip;
    t.total += p.total;
    t.payments += 1;
  }
  return t;
}

/**
 * The till over a period: the same totals as a day, plus one line per day that had money in it
 * (oldest first). `payments` carry their own `date`; pack sales too.
 * @param {{ date: string, method: string, total: number, tip: number, services: number, extras: object[], discount: number, packUse?: object }[]} payments
 * @param {{ date: string, method: string, amount: number }[]} packSales
 */
function tillByDay(payments, packSales = []) {
  const dates = [...new Set([...payments.map((p) => p.date), ...packSales.map((x) => x.date)])].sort();
  const days = dates.map((date) => {
    const t = tillTotals(payments.filter((p) => p.date === date), packSales.filter((x) => x.date === date));
    return { date, total: t.cash + t.card + t.bizum + t.other, payments: t.payments, cash: t.cash, card: t.card, bizum: t.bizum, other: t.other, packSales: t.packSales, tips: t.tips };
  });
  return { totals: tillTotals(payments, packSales), days };
}

module.exports = { buildPayment, tillTotals, tillByDay, METHODS, CHARGEABLE };
