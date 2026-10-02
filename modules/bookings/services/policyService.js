/**
 * Cancellation / change policy for customers (see models/BookingPolicy).
 */
const BookingPolicy = require('../models/BookingPolicy');
const { BookingError } = require('../lib/errors');

const HOUR = 60 * 60 * 1000;
const DEFAULTS = { changeMinHours: 0, allowReschedule: true, note: '' };
const ALLOWED_HOURS = [0, 1, 2, 3, 4, 6, 12, 24, 48, 72];

function shape(doc) {
  return {
    changeMinHours: doc?.changeMinHours ?? DEFAULTS.changeMinHours,
    allowReschedule: doc?.allowReschedule ?? DEFAULTS.allowReschedule,
    note: doc?.note ?? DEFAULTS.note,
  };
}

async function getPolicy(businessId) {
  return shape(await BookingPolicy.findOne({ businessId }).lean());
}

function policyInput(body = {}) {
  const bad = (m) => { throw new BookingError(400, m, 'BAD_REQUEST'); };
  const out = {};
  if (body.changeMinHours !== undefined) {
    const n = Number(body.changeMinHours);
    if (!ALLOWED_HOURS.includes(n)) bad('La antelación mínima no es válida');
    out.changeMinHours = n;
  }
  if (body.allowReschedule !== undefined) {
    if (typeof body.allowReschedule !== 'boolean') bad('Permitir cambios no es válido');
    out.allowReschedule = body.allowReschedule;
  }
  if (body.note !== undefined) {
    const note = String(body.note || '').trim();
    if (note.length > 500) bad('El texto de la política es demasiado largo (máx. 500)');
    out.note = note;
  }
  return out;
}

async function savePolicy(businessId, body) {
  const set = policyInput(body);
  const doc = await BookingPolicy.findOneAndUpdate({ businessId }, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  return shape(doc);
}

/**
 * What the customer can still do with `booking` now.
 * { canCancel, canReschedule, deadline (Date|null), reason }
 */
function customerRights(booking, policy, now = new Date()) {
  const open = ['pending', 'confirmed'].includes(booking.status);
  const start = new Date(booking.start).getTime();
  const deadline = new Date(start - (policy.changeMinHours || 0) * HOUR);
  let reason = null;
  if (!open) reason = booking.status === 'cancelled' ? 'cancelled' : 'closed';
  else if (start <= now.getTime()) reason = 'past';
  else if (deadline.getTime() <= now.getTime()) reason = 'too_late';
  else if (booking.payment) reason = 'paid';
  const ok = !reason;
  return {
    canCancel: ok,
    canReschedule: ok && policy.allowReschedule,
    deadline: policy.changeMinHours ? deadline : null,
    reason,
  };
}

module.exports = { getPolicy, savePolicy, policyInput, customerRights, ALLOWED_HOURS };
