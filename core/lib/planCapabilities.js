/**
 * Central plan definitions and capability helpers.
 *
 * Source of truth for what each plan can do.
 */

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    maxReservationsPerMonth: 30,
    maxMembers: 1,
    maxTables: 15,
    maxShifts: 2,
    maxVacations: 1,
    autoEmails: false,
    staffNotifications: false,
    marketing: false,
    promoCodes: false,
    iframeEmbed: false,
    removeVetraBranding: false,
    pendingApprovalControl: false,
    advancedAnalytics: false,
    autoReminders: false,
    advancedReminders: false,
    noShowTracking: false,
    dataExport: false,
    reservationPayments: false,
    // Appointments (bookings module)
    maxProfessionals: 1,
    maxBookingsPerMonth: 30,
    bookingReminders: false,
    followUps: false,
    modulesAllowed: {
      staff: false,
      expenses: false,
      purchases: false,
      thefork: false,
      bookings: true,
    },
  },

  basic: {
    id: 'basic',
    name: 'Basic',
    maxReservationsPerMonth: Infinity,
    maxMembers: 1,
    maxTables: Infinity,
    maxShifts: Infinity,
    maxVacations: Infinity,
    autoEmails: true,
    staffNotifications: true,
    marketing: false,
    promoCodes: false,
    iframeEmbed: true,
    removeVetraBranding: false,
    pendingApprovalControl: true,
    advancedAnalytics: false,
    autoReminders: false,
    advancedReminders: false,
    noShowTracking: true,
    dataExport: true,
    reservationPayments: false,
    // Appointments: everything one person needs to run the business
    maxProfessionals: 1,
    maxBookingsPerMonth: Infinity,
    bookingReminders: true,
    followUps: false,
    modulesAllowed: {
      staff: false,
      expenses: false,
      purchases: false,
      thefork: false,
      bookings: true,
    },
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    maxReservationsPerMonth: Infinity,
    maxMembers: Infinity,
    maxTables: Infinity,
    maxShifts: Infinity,
    maxVacations: Infinity,
    autoEmails: true,
    staffNotifications: true,
    marketing: true,
    promoCodes: true,
    iframeEmbed: true,
    removeVetraBranding: false,
    pendingApprovalControl: true,
    advancedAnalytics: true,
    autoReminders: true,
    advancedReminders: true,
    noShowTracking: true,
    dataExport: true,
    reservationPayments: true,
    // Appointments: a team, and Vetra working for you
    maxProfessionals: Infinity,
    maxBookingsPerMonth: Infinity,
    bookingReminders: true,
    followUps: true,
    modulesAllowed: {
      staff: true,
      expenses: true,
      purchases: true,
      thefork: true,
      bookings: true,
    },
  },
};

// No paid plan and no trial (trial ended, subscription cancelled): the business
// can look at its data and pay, but not take new bookings or change things
// (see middleware/readOnlyGuard). Businesses from before the trial model keep
// the old free access instead (legacyAccess).
PLANS.expired = {
  ...PLANS.free,
  id: 'expired',
  name: 'Sin plan',
  readOnly: true,
  maxReservationsPerMonth: 0,
  maxBookingsPerMonth: 0,
  autoEmails: false,
  bookingReminders: false,
  followUps: false,
};

// New businesses: 14 days of Pro, no card.
const TRIAL_DAYS = 14;

// Modules that stay off until enabled per business (moduleOverrides.<key>.enabled = true).
// 'bookings' is the new generic agenda, enabled only for pilot businesses.
const OPT_IN_MODULES = new Set(['thefork', 'bookings']);

// Days a business keeps its plan after a failed charge, while Stripe retries.
const PAYMENT_GRACE_DAYS = 14;

function inPaymentGrace(business, now = new Date()) {
  if (business?.subscriptionStatus !== 'past_due') return false;
  const since = business.paymentFailedAt ? new Date(business.paymentFailedAt) : null;
  if (!since) return false; // failed before we recorded when: as before, no grace
  return now.getTime() - since.getTime() < PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

function inTrial(business, now = new Date()) {
  if (business?.subscriptionStatus !== 'trialing') return false;
  // A Stripe trial is managed by Stripe (its webhooks change the status when it ends)
  if (business.stripeSubscriptionId) return true;
  // Our own trial (no card): until trialEndsAt
  return Boolean(business.trialEndsAt) && new Date(business.trialEndsAt).getTime() > now.getTime();
}

function getEffectivePlan(business, now = new Date()) {
  const { plan, subscriptionStatus } = business || {};
  if ((plan === 'basic' || plan === 'pro')
    && (subscriptionStatus === 'active' || inTrial(business, now) || inPaymentGrace(business, now))) {
    return plan;
  }
  // Businesses from before the trial model keep the old free access
  if (business?.legacyAccess) return 'free';
  return 'expired';
}

// Appointment features that businesses created before the plan limits keep
// (Business.legacyAccess), so nobody loses what they already use.
const LEGACY_APPOINTMENT_ACCESS = {
  maxProfessionals: Infinity,
  maxBookingsPerMonth: Infinity,
  bookingReminders: true,
  followUps: true,
};

// Business fields getCapabilities needs (for .select()).
const PLAN_FIELDS = 'plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId';

function getCapabilities(business) {
  const effectivePlan = getEffectivePlan(business);
  const caps = PLANS[effectivePlan] ?? PLANS.free;
  return business?.legacyAccess ? { ...caps, ...LEGACY_APPOINTMENT_ACCESS } : caps;
}

// JSON-safe view of the plan capabilities for the client: Infinity becomes null (= unlimited).
function serializeCapabilities(business) {
  const { modulesAllowed, ...caps } = getCapabilities(business);
  return Object.fromEntries(
    Object.entries(caps).map(([key, value]) => [key, value === Infinity ? null : value]),
  );
}

// Cheapest plan that includes `feature`, as a user-facing upgrade message.
function upgradeMessage(feature) {
  const minimum = ['basic', 'pro'].find((id) => PLANS[id][feature] === true || PLANS[id][feature] === Infinity);
  if (!minimum) return 'Esta función no está disponible en tu plan';
  return minimum === 'pro'
    ? 'Esta función requiere el plan Pro'
    : 'Esta función requiere el plan Basic o superior';
}

function canUseFeature(business, feature) {
  const caps = getCapabilities(business);
  const val = caps[feature];
  return val === true || val === Infinity;
}

/**
 * Effective module access.
 * enabled = allowedByPlan AND businessOverride !== false
 */
function getModuleAccess(business, moduleKey) {
  const caps = getCapabilities(business);
  const allowedByPlan = !!caps?.modulesAllowed?.[moduleKey];
  const override = business?.moduleOverrides?.[moduleKey];
  // Appointment businesses get the agenda on by default; everyone else must opt in.
  const defaultOverrideEnabled = moduleKey === 'bookings'
    ? business?.businessType === 'appointments'
    : !OPT_IN_MODULES.has(moduleKey);

  const overrideEnabled =
    typeof override?.enabled === 'boolean'
      ? override.enabled
      : defaultOverrideEnabled;

  return {
    moduleKey,
    allowedByPlan,
    overrideEnabled,
    enabled: allowedByPlan && overrideEnabled,
  };
}

function canUseModule(business, moduleKey) {
  return getModuleAccess(business, moduleKey).enabled;
}

function getAllModuleAccess(business) {
  const caps = getCapabilities(business);
  const modules = caps?.modulesAllowed || {};
  const result = {};

  Object.keys(modules).forEach((moduleKey) => {
    result[moduleKey] = getModuleAccess(business, moduleKey);
  });

  return result;
}

/**
 * Marks items beyond the plan limit as locked.
 * Input must be pre-sorted oldest-first (createdAt ASC) so the active set
 * is deterministic: the user's oldest items are always the active ones.
 * Accepts Mongoose documents or plain objects; always returns plain objects.
 */
function markLockedEntities(docs, maxCount) {
  return docs.map((doc, i) => {
    const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    obj.isLocked = maxCount !== Infinity && i >= maxCount;
    return obj;
  });
}

module.exports = {
  PLANS,
  PLAN_FIELDS,
  TRIAL_DAYS,
  inTrial,
  PAYMENT_GRACE_DAYS,
  inPaymentGrace,
  getEffectivePlan,
  getCapabilities,
  serializeCapabilities,
  upgradeMessage,
  canUseFeature,
  getModuleAccess,
  canUseModule,
  getAllModuleAccess,
  markLockedEntities,
};

