/**
 * Pro is priced per professional: 39,99 € includes up to 3, then 5 € each
 * (a graduated Stripe price; the subscription quantity = professionals).
 * Modules register how to count a business's professionals (core cannot
 * import them); businesses without a counter (restaurants) count as 1.
 */
const Business = require('../models/Business');

const PRO_INCLUDED_PROFESSIONALS = 3;
const PRO_EXTRA_PROFESSIONAL_CENTS = 500;

let counter = null;
function registerSeatCounter(fn) { counter = fn; }

async function seatsFor(business) {
  if (!counter || business?.businessType !== 'appointments') return 1;
  return Math.max(1, await counter(business._id));
}

// Only once STRIPE_PRICE_PRO is the graduated price (39,99 € up to 3, then 5 €
// per unit). With a flat price a quantity > 1 would multiply the whole fee.
function perProfessionalBilling() {
  return process.env.STRIPE_PRO_PER_PROFESSIONAL === 'true';
}

/** Subscription quantity for a plan. */
async function quantityFor(business, plan) {
  return plan === 'pro' && perProfessionalBilling() ? seatsFor(business) : 1;
}

/**
 * Keeps the Stripe quantity equal to the professionals of a Pro business.
 * Never throws: billing drift is logged and fixed on the next change.
 */
async function syncSeats(businessId) {
  try {
    if (!perProfessionalBilling()) return null;
    const business = await Business.findById(businessId)
      .select('businessType plan subscriptionStatus stripeSubscriptionId').lean();
    if (!business?.stripeSubscriptionId || business.plan !== 'pro') return null;
    if (!['active', 'trialing', 'past_due'].includes(business.subscriptionStatus)) return null;
    const quantity = await seatsFor(business);
    const stripeService = require('./stripe');
    return await stripeService.setQuantity(business.stripeSubscriptionId, quantity);
  } catch (err) {
    console.error('[billing] seat sync failed for', String(businessId), err.message);
    return null;
  }
}

module.exports = {
  PRO_INCLUDED_PROFESSIONALS, PRO_EXTRA_PROFESSIONAL_CENTS,
  registerSeatCounter, seatsFor, quantityFor, syncSeats, perProfessionalBilling,
};
