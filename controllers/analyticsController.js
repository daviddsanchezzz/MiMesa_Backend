const Reservation = require('../models/Reservation');
const Business = require('../models/Business');
const mongoose = require('mongoose');
const { canUseFeature } = require('../lib/planCapabilities');

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 29);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

exports.getOverview = async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).select(
      'plan subscriptionStatus maxPeoplePerSlot'
    );
    if (!business) return res.status(404).json({ message: 'Negocio no encontrado' });
    if (!canUseFeature(business, 'advancedAnalytics')) {
      return res.status(403).json({
        message: 'Esta funcion requiere plan Pro',
        feature: 'advancedAnalytics',
        upgradeRequired: true,
      });
    }

    const range = defaultRange();
    const from = req.query.from || range.from;
    const to = req.query.to || range.to;

    const rows = await Reservation.find({
      businessId: req.businessId,
      date: { $gte: from, $lte: to },
    }).select('date time people status customerId');

    const reservationsByDayMap = new Map();
    const peakHoursMap = new Map();
    const slotLoadMap = new Map();
    let total = 0;
    let cancelled = 0;
    let noShow = 0;

    const activeForOccupancy = new Set(['confirmed', 'seated']);
    const activeForPeaks = new Set(['pending', 'confirmed', 'seated', 'no_show']);

    for (const r of rows) {
      total += 1;
      if (r.status === 'cancelled') cancelled += 1;
      if (r.status === 'no_show') noShow += 1;

      const dayEntry = reservationsByDayMap.get(r.date) || {
        date: r.date,
        total: 0,
        pending: 0,
        confirmed: 0,
        seated: 0,
        cancelled: 0,
        no_show: 0,
        people: 0,
      };
      dayEntry.total += 1;
      dayEntry.people += Number(r.people || 0);
      dayEntry[r.status] = (dayEntry[r.status] || 0) + 1;
      reservationsByDayMap.set(r.date, dayEntry);

      if (activeForPeaks.has(r.status)) {
        peakHoursMap.set(r.time, (peakHoursMap.get(r.time) || 0) + 1);
      }
      if (activeForOccupancy.has(r.status)) {
        const key = `${r.date}__${r.time}`;
        slotLoadMap.set(key, (slotLoadMap.get(key) || 0) + Number(r.people || 0));
      }
    }

    const reservationsByDay = [...reservationsByDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const peakHours = [...peakHoursMap.entries()]
      .map(([time, reservations]) => ({ time, reservations }))
      .sort((a, b) => (b.reservations - a.reservations) || a.time.localeCompare(b.time))
      .slice(0, 10);

    let occupancyEstimated = null;
    if (business.maxPeoplePerSlot) {
      const slotValues = [...slotLoadMap.values()];
      if (slotValues.length > 0) {
        const totalPct = slotValues.reduce((sum, used) => {
          const pct = Math.min(100, (used / business.maxPeoplePerSlot) * 100);
          return sum + pct;
        }, 0);
        occupancyEstimated = {
          avgPct: Number((totalPct / slotValues.length).toFixed(2)),
          slotsMeasured: slotValues.length,
          maxPeoplePerSlot: business.maxPeoplePerSlot,
        };
      } else {
        occupancyEstimated = { avgPct: 0, slotsMeasured: 0, maxPeoplePerSlot: business.maxPeoplePerSlot };
      }
    }

    const distinctCustomers = [...new Set(
      rows
        .map((r) => r.customerId?.toString())
        .filter(Boolean)
    )];

    let newCustomers = 0;
    if (distinctCustomers.length > 0) {
      const firstDates = await Reservation.aggregate([
        {
          $match: {
            businessId: business._id,
            customerId: { $in: distinctCustomers.map((id) => new mongoose.Types.ObjectId(id)) },
          },
        },
        {
          $group: {
            _id: '$customerId',
            firstDate: { $min: '$date' },
          },
        },
      ]);
      newCustomers = firstDates.filter((x) => x.firstDate >= from && x.firstDate <= to).length;
    }

    const recurrentCustomers = Math.max(0, distinctCustomers.length - newCustomers);
    const cancelRate = total > 0 ? Number(((cancelled / total) * 100).toFixed(2)) : 0;

    return res.json({
      range: { from, to },
      summary: {
        totalReservations: total,
        cancellations: cancelled,
        cancelRatePct: cancelRate,
        noShows: noShow,
      },
      reservationsByDay,
      peakHours,
      occupancyEstimated,
      customerMix: {
        distinctCustomers: distinctCustomers.length,
        newCustomers,
        recurrentCustomers,
        ratio: {
          newPct: distinctCustomers.length > 0 ? Number(((newCustomers / distinctCustomers.length) * 100).toFixed(2)) : 0,
          recurrentPct: distinctCustomers.length > 0 ? Number(((recurrentCustomers / distinctCustomers.length) * 100).toFixed(2)) : 0,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
