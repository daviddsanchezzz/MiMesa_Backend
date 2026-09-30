/**
 * What the business plan allows in the agenda (see core/lib/planCapabilities):
 *   Free   1 professional, 30 appointments a month, no reminders or follow-ups
 *   Basic  1 professional, unlimited, reminders          (19 €)
 *   Pro    whole team, reminders, "te toca volver", reviews (39 €)
 * Businesses created before these limits keep everything (legacyAccess).
 */
const Business = require('../../../core/models/Business');
const { getCapabilities, PLAN_FIELDS } = require('../../../core/lib/planCapabilities');
const { BookingError } = require('./errors');

async function capsFor(businessId) {
  const business = await Business.findById(businessId).select(`${PLAN_FIELDS} timezone`).lean();
  return business ? getCapabilities(business) : getCapabilities({});
}

function planError(message, feature) {
  return new BookingError(403, message, 'PLAN_LIMIT', { feature, upgradeRequired: true });
}

/** Staff over the plan limit (after a downgrade): the newest ones rest. */
function lockedStaff(resources, caps) {
  const max = caps.maxProfessionals;
  if (max === undefined || max === Infinity) return new Set();
  const staff = resources
    .filter((r) => r.kind === 'staff' && r.active !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || String(a._id).localeCompare(String(b._id)));
  return new Set(staff.slice(max).map((r) => String(r._id)));
}

async function assertCanAddProfessional(businessId, Resource, { excludeId = null } = {}) {
  const caps = await capsFor(businessId);
  if (caps.maxProfessionals === Infinity) return;
  const count = await Resource.countDocuments({ businessId, kind: 'staff', active: true, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  if (count >= caps.maxProfessionals) {
    throw planError(`Tu plan incluye ${caps.maxProfessionals} profesional. Pasa a Pro para trabajar con tu equipo.`, 'maxProfessionals');
  }
}

async function assertBookingQuota(businessId, Booking, { online }) {
  const caps = await capsFor(businessId);
  if (caps.maxBookingsPerMonth === Infinity) return;
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const used = await Booking.countDocuments({ businessId, createdAt: { $gte: startOfMonth }, status: { $ne: 'cancelled' } });
  if (used < caps.maxBookingsPerMonth) return;
  throw online
    ? planError('Ahora mismo no se pueden reservar más citas online en este negocio. Llama para pedir cita, por favor.', 'maxBookingsPerMonth')
    : planError(`Has llegado a las ${caps.maxBookingsPerMonth} citas de este mes del plan gratuito. Elige un plan para seguir sin límites.`, 'maxBookingsPerMonth');
}

async function assertFeature(businessId, feature, message) {
  const caps = await capsFor(businessId);
  if (!caps[feature]) throw planError(message, feature);
}

module.exports = { capsFor, lockedStaff, assertCanAddProfessional, assertBookingQuota, assertFeature, planError };
