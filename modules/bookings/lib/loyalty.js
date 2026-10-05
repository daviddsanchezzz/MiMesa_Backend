/**
 * Loyalty: every Nth paid visit earns a reward. Stateless: it only depends on
 * how many visits the customer has paid, so it can never get out of step.
 * Pure. Money in cents.
 */
const { BookingError } = require('./errors');

const DEFAULTS = { enabled: false, every: 10, reward: { type: 'percent', value: 10 } };
const MAX_AMOUNT = 10_000_00;
const bad = (msg) => { throw new BookingError(400, msg, 'BAD_REQUEST'); };

function shape(doc) {
  return {
    enabled: !!doc?.enabled,
    every: doc?.every || DEFAULTS.every,
    reward: { type: doc?.reward?.type || DEFAULTS.reward.type, value: doc?.reward?.value || DEFAULTS.reward.value },
  };
}

function settingsInput(body = {}) {
  if (typeof body.enabled !== 'boolean') bad('Activar o desactivar no es válido');
  const every = Number(body.every);
  if (!Number.isInteger(every) || every < 2 || every > 100) bad('El número de visitas debe estar entre 2 y 100');
  const type = body.reward?.type;
  if (!['percent', 'amount'].includes(type)) bad('Elige el tipo de premio');
  const value = Number(body.reward?.value);
  if (!Number.isInteger(value) || value < 1) bad('El premio no es válido');
  if (type === 'percent' && value > 100) bad('El descuento no puede pasar del 100 %');
  if (type === 'amount' && value > MAX_AMOUNT) bad('El importe del premio es demasiado alto');
  return { enabled: body.enabled, every, reward: { type, value } };
}

/** Where a customer is: `paidVisits` already paid, so the next one is number paidVisits + 1. */
function progress(settings, paidVisits) {
  const s = shape(settings);
  return {
    enabled: s.enabled,
    every: s.every,
    reward: s.reward,
    paidVisits,
    nextVisit: paidVisits + 1,
    rewardDue: s.enabled && (paidVisits + 1) % s.every === 0,
    toNext: s.every - (paidVisits % s.every),   // 1 = the next visit is the reward
  };
}

/** What the reward takes off a ticket of `base` cents. */
function discountFor(reward, base) {
  const raw = reward.type === 'percent' ? Math.round((base * reward.value) / 100) : reward.value;
  return Math.max(0, Math.min(raw, base));
}

module.exports = { DEFAULTS, shape, settingsInput, progress, discountFor };
