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
    removeTableoBranding: false,
    pendingApprovalControl: false,
    advancedAnalytics: false,
    autoReminders: false,
    advancedReminders: false,
    noShowTracking: false,
    dataExport: false,
    reservationPayments: false,
    modulesAllowed: {
      staff: false,
      expenses: false,
      purchases: false,
      thefork: false,
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
    removeTableoBranding: false,
    pendingApprovalControl: true,
    advancedAnalytics: false,
    autoReminders: false,
    advancedReminders: false,
    noShowTracking: true,
    dataExport: true,
    reservationPayments: false,
    modulesAllowed: {
      staff: false,
      expenses: false,
      purchases: false,
      thefork: false,
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
    removeTableoBranding: false,
    pendingApprovalControl: true,
    advancedAnalytics: true,
    autoReminders: true,
    advancedReminders: true,
    noShowTracking: true,
    dataExport: true,
    reservationPayments: true,
    modulesAllowed: {
      staff: true,
      expenses: true,
      purchases: true,
      thefork: true,
    },
  },
};

function getEffectivePlan(business) {
  const { plan, subscriptionStatus } = business;
  const activeStatuses = ['active', 'trialing'];
  if ((plan === 'basic' || plan === 'pro') && activeStatuses.includes(subscriptionStatus)) {
    return plan;
  }
  return 'free';
}

function getCapabilities(business) {
  const effectivePlan = getEffectivePlan(business);
  return PLANS[effectivePlan] ?? PLANS.free;
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
  const defaultOverrideEnabled = moduleKey === 'thefork' ? false : true;

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

async function checkReservationLimit(businessId, business) {
  const caps = getCapabilities(business);
  if (caps.maxReservationsPerMonth === Infinity) return { allowed: true };

  const Reservation = require('../models/Reservation');
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const used = await Reservation.countDocuments({
    businessId,
    createdAt: { $gte: startOfMonth },
    status: { $ne: 'cancelled' },
  });

  return {
    allowed: used < caps.maxReservationsPerMonth,
    used,
    limit: caps.maxReservationsPerMonth,
  };
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
  getEffectivePlan,
  getCapabilities,
  canUseFeature,
  getModuleAccess,
  canUseModule,
  getAllModuleAccess,
  checkReservationLimit,
  markLockedEntities,
};
