/**
 * Without a plan (trial over, subscription cancelled) a business is read-only:
 * it can look at everything, export its data and pay, but not change things.
 * Runs inside requireAuth for every private request that writes.
 */
const Business = require('../models/Business');
const { getEffectivePlan, PLAN_FIELDS } = require('../lib/planCapabilities');

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Always allowed, even without a plan: paying, the account, leaving, exporting.
const ALLOWED = [
  /^\/api\/stripe(\/|$)/,
  /^\/api\/users(\/|$)/,
  /^\/api\/businesses(\/|$)/,       // create another business / delete this one
  /^\/api\/push(\/|$)/,
  /^\/api\/auth\/(logout|profile|me)/,
  /^\/api\/dev(\/|$)/,
];

async function readOnlyBlocked(req) {
  if (!WRITE.has(req.method) || !req.businessId || req.isDev) return false;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (ALLOWED.some((re) => re.test(path))) return false;
  // A customer's right to erasure doesn't depend on the business paying
  if (req.method === 'DELETE' && /^\/api\/customers\/[^/]+$/.test(path)) return false;
  const business = await Business.findById(req.businessId).select(PLAN_FIELDS).lean();
  return Boolean(business) && getEffectivePlan(business) === 'expired';
}

const READ_ONLY_RESPONSE = {
  code: 'SUBSCRIPTION_REQUIRED',
  message: 'Tu periodo de prueba ha terminado. Elige un plan para seguir trabajando con Vetra; tus datos siguen aquí.',
};

module.exports = { readOnlyBlocked, READ_ONLY_RESPONSE, ALLOWED };
