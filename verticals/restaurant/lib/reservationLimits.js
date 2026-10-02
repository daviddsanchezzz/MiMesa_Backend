const { getCapabilities } = require('../../../core/lib/planCapabilities');

// Monthly reservation quota of the business plan (Free: 30/month).
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

module.exports = { checkReservationLimit };
