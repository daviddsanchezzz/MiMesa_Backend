/**
 * Central plan definitions and capability helpers.
 *
 * Source of truth for what each plan can do.
 */

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    // Usage limits
    maxReservationsPerMonth: 30,
    maxMembers: 1,
    maxTables: 15,
    maxShifts: 2,
    maxVacations: 1,
    // Feature flags
    autoEmails: false,
    staffNotifications: true,   // restaurante siempre recibe notificación interna
    marketing: false,
    promoCodes: false,
    iframeEmbed: true,
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
    },
  },

  basic: {
    id: 'basic',
    name: 'Basic',
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
    removeTableoBranding: true,
    pendingApprovalControl: true,
    advancedAnalytics: true,
    autoReminders: false,       // recordatorios 24h solo en Pro
    advancedReminders: false,
    noShowTracking: true,
    dataExport: true,
    reservationPayments: true,
    modulesAllowed: {
      staff: true,
      expenses: true,
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
    removeTableoBranding: true,
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

  const overrideEnabled =
    typeof override?.enabled === 'boolean'
      ? override.enabled
      : true;

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

module.exports = {
  PLANS,
  getEffectivePlan,
  getCapabilities,
  canUseFeature,
  getModuleAccess,
  canUseModule,
  getAllModuleAccess,
  checkReservationLimit,
};
