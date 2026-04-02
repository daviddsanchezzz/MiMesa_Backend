/**
 * Central plan definitions and capability helpers.
 *
 * Source of truth for what each plan can do.
 * Both the middleware (requirePlan) and controllers import from here
 * so there is never a mismatch between what's gated and what's advertised.
 *
 * Adding a future "pro" plan:
 *   1. Add a 'pro' entry to PLANS
 *   2. Add price mapping in services/stripe.js planFromPriceId()
 *   3. No other changes needed — feature flags propagate automatically
 */

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    // Usage limits
    maxReservationsPerMonth: 30,
    maxMembers:              1,
    maxTables:               15,
    maxShifts:               2,
    maxVacations:            1,
    // Feature flags
    autoEmails:              false, // confirmation/cancellation emails to guests
    staffNotifications:      false, // new-reservation email alerts to staff
    marketing:               false, // email campaigns
    promoCodes:              false, // promo code management
    iframeEmbed:             true,  // public page + iframe embed
    removeTableoBranding:    false,
    // Future Pro features — disabled in both Free and Basic for now
    pendingApprovalControl:  false,
    advancedAnalytics:       false,
    autoReminders:           false,
    advancedReminders:       false, // backward-compatible alias
    noShowTracking:          false,
    dataExport:              false,
  },

  basic: {
    id: 'basic',
    name: 'Basic',
    maxReservationsPerMonth: Infinity,
    maxMembers:              Infinity,
    maxTables:               Infinity,
    maxShifts:               Infinity,
    maxVacations:            Infinity,
    autoEmails:              true,
    staffNotifications:      true,
    marketing:               true,
    promoCodes:              true,
    iframeEmbed:             true,
    removeTableoBranding:    true,
    // Future Pro features
    pendingApprovalControl:  true,
    advancedAnalytics:       true,
    autoReminders:           true,
    advancedReminders:       true, // backward-compatible alias
    noShowTracking:          true,
    dataExport:              true,
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    maxReservationsPerMonth: Infinity,
    maxMembers:              Infinity,
    maxTables:               Infinity,
    maxShifts:               Infinity,
    maxVacations:            Infinity,
    autoEmails:              true,
    staffNotifications:      true,
    marketing:               true,
    promoCodes:              true,
    iframeEmbed:             true,
    removeTableoBranding:    true,
    pendingApprovalControl:  true,
    advancedAnalytics:       true,
    autoReminders:           true,
    advancedReminders:       true, // backward-compatible alias
    noShowTracking:          true,
    dataExport:              true,
  },
};

/**
 * Determine the effective plan a business currently has access to.
 * Plan is only "active" when Stripe confirms it (status: active | trialing).
 * Everything else falls back to 'free' regardless of what's stored in `plan`.
 */
function getEffectivePlan(business) {
  const { plan, subscriptionStatus } = business;
  const activeStatuses = ['active', 'trialing'];
  if ((plan === 'basic' || plan === 'pro') && activeStatuses.includes(subscriptionStatus)) {
    return plan;
  }
  return 'free';
}

/** Get the full capabilities object for a business. */
function getCapabilities(business) {
  const effectivePlan = getEffectivePlan(business);
  return PLANS[effectivePlan] ?? PLANS.free;
}

/** Check if a business can use a specific named feature. */
function canUseFeature(business, feature) {
  const caps = getCapabilities(business);
  const val = caps[feature];
  return val === true || val === Infinity;
}

/**
 * Check monthly reservation limit.
 * Returns { allowed: true } or { allowed: false, used: N, limit: N }
 */
async function checkReservationLimit(businessId, business) {
  const caps = getCapabilities(business);
  if (caps.maxReservationsPerMonth === Infinity) return { allowed: true };

  const Reservation = require('../models/Reservation');
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const used = await Reservation.countDocuments({
    businessId,
    createdAt:  { $gte: startOfMonth },
    status:     { $ne: 'cancelled' },
  });

  return {
    allowed: used < caps.maxReservationsPerMonth,
    used,
    limit: caps.maxReservationsPerMonth,
  };
}

module.exports = { PLANS, getEffectivePlan, getCapabilities, canUseFeature, checkReservationLimit };
