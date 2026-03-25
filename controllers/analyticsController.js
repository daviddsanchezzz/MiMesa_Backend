const Reservation = require('../models/Reservation');
const Business = require('../models/Business');
const mongoose = require('mongoose');
const { canUseFeature } = require('../lib/planCapabilities');

function dateRange(daysBack, offsetDays = 0) {
  const to = new Date();
  to.setDate(to.getDate() - offsetDays);
  const from = new Date(to);
  from.setDate(to.getDate() - (daysBack - 1));
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

async function queryPeriod(businessId, from, to) {
  return Reservation.find({
    businessId,
    date: { $gte: from, $lte: to },
  }).select('date time people status customerId');
}

function summarise(rows) {
  let total = 0, cancelled = 0, noShow = 0, confirmed = 0, totalPeople = 0;
  const peakHoursMap = new Map();
  const reservationsByDayMap = new Map();
  const slotLoadMap = new Map();
  const weekdayMap = new Map();

  const activeForPeaks = new Set(['pending', 'confirmed', 'seated', 'no_show']);
  const activeForOccupancy = new Set(['confirmed', 'seated']);

  const WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  for (const r of rows) {
    total += 1;
    if (r.status === 'cancelled') cancelled += 1;
    if (r.status === 'no_show') noShow += 1;
    if (r.status === 'confirmed' || r.status === 'seated') confirmed += 1;
    totalPeople += Number(r.people || 0);

    // Daily breakdown
    const dayEntry = reservationsByDayMap.get(r.date) || {
      date: r.date,
      total: 0,
      confirmed: 0,
      seated: 0,
      cancelled: 0,
      no_show: 0,
      pending: 0,
      people: 0,
    };
    dayEntry.total += 1;
    dayEntry.people += Number(r.people || 0);
    dayEntry[r.status] = (dayEntry[r.status] || 0) + 1;
    reservationsByDayMap.set(r.date, dayEntry);

    // Peak hours
    if (activeForPeaks.has(r.status)) {
      peakHoursMap.set(r.time, (peakHoursMap.get(r.time) || 0) + 1);
    }

    // Slot load for occupancy
    if (activeForOccupancy.has(r.status)) {
      const key = `${r.date}__${r.time}`;
      slotLoadMap.set(key, (slotLoadMap.get(key) || 0) + Number(r.people || 0));
    }

    // Weekday breakdown (skip cancelled)
    if (r.status !== 'cancelled') {
      const d = new Date(r.date + 'T00:00:00');
      const wd = WEEKDAYS_ES[d.getDay()];
      const wdEntry = weekdayMap.get(wd) || { day: wd, dayIndex: d.getDay(), reservations: 0, people: 0 };
      wdEntry.reservations += 1;
      wdEntry.people += Number(r.people || 0);
      weekdayMap.set(wd, wdEntry);
    }
  }

  const reservationsByDay = [...reservationsByDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const peakHours = [...peakHoursMap.entries()]
    .map(([time, reservations]) => ({ time, reservations }))
    .sort((a, b) => (b.reservations - a.reservations) || a.time.localeCompare(b.time))
    .slice(0, 10);

  const busyWeekdays = [...weekdayMap.values()]
    .sort((a, b) => a.dayIndex - b.dayIndex);

  const cancelRate = total > 0 ? Number(((cancelled / total) * 100).toFixed(1)) : 0;
  const avgPartySize = total > 0 ? Number((totalPeople / total).toFixed(1)) : 0;

  return {
    summary: {
      totalReservations: total,
      confirmed,
      cancellations: cancelled,
      cancelRatePct: cancelRate,
      noShows: noShow,
      avgPartySize,
      totalCovers: totalPeople,
    },
    reservationsByDay,
    peakHours,
    busyWeekdays,
    slotLoadMap,
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

    const period = Math.min(Math.max(parseInt(req.query.period) || 30, 7), 365);
    const current = dateRange(period);
    const prev = dateRange(period, period);

    const [currentRows, prevRows] = await Promise.all([
      queryPeriod(req.businessId, current.from, current.to),
      queryPeriod(req.businessId, prev.from, prev.to),
    ]);

    const cur = summarise(currentRows);
    const pre = summarise(prevRows);

    // Trend deltas (percentage change vs previous period)
    function delta(cur, prev) {
      if (prev === 0) return cur > 0 ? 100 : 0;
      return Number((((cur - prev) / prev) * 100).toFixed(1));
    }

    const trend = {
      totalReservations: delta(cur.summary.totalReservations, pre.summary.totalReservations),
      cancellations: delta(cur.summary.cancellations, pre.summary.cancellations),
      noShows: delta(cur.summary.noShows, pre.summary.noShows),
      totalCovers: delta(cur.summary.totalCovers, pre.summary.totalCovers),
    };

    // Occupancy
    let occupancyEstimated = null;
    if (business.maxPeoplePerSlot) {
      const slotValues = [...cur.slotLoadMap.values()];
      if (slotValues.length > 0) {
        const totalPct = slotValues.reduce((sum, used) => {
          return sum + Math.min(100, (used / business.maxPeoplePerSlot) * 100);
        }, 0);
        occupancyEstimated = {
          avgPct: Number((totalPct / slotValues.length).toFixed(1)),
          slotsMeasured: slotValues.length,
          maxPeoplePerSlot: business.maxPeoplePerSlot,
        };
      } else {
        occupancyEstimated = { avgPct: 0, slotsMeasured: 0, maxPeoplePerSlot: business.maxPeoplePerSlot };
      }
    }

    // Customer mix
    const distinctCustomers = [...new Set(
      currentRows.map((r) => r.customerId?.toString()).filter(Boolean)
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
        { $group: { _id: '$customerId', firstDate: { $min: '$date' } } },
      ]);
      newCustomers = firstDates.filter((x) => x.firstDate >= current.from && x.firstDate <= current.to).length;
    }
    const recurrentCustomers = Math.max(0, distinctCustomers.length - newCustomers);

    return res.json({
      period,
      range: { from: current.from, to: current.to },
      prevRange: { from: prev.from, to: prev.to },
      summary: cur.summary,
      trend,
      reservationsByDay: cur.reservationsByDay,
      peakHours: cur.peakHours,
      busyWeekdays: cur.busyWeekdays,
      occupancyEstimated,
      customerMix: {
        distinctCustomers: distinctCustomers.length,
        newCustomers,
        recurrentCustomers,
        newPct: distinctCustomers.length > 0 ? Number(((newCustomers / distinctCustomers.length) * 100).toFixed(1)) : 0,
        recurrentPct: distinctCustomers.length > 0 ? Number(((recurrentCustomers / distinctCustomers.length) * 100).toFixed(1)) : 0,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
