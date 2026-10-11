/**
 * Loads what Estadísticas needs (the period, the one before it and a year of
 * history to tell new customers from returning ones) for the pure calculator.
 */
const Business = require('../../../core/models/Business');
const { businessTimezone } = require('../../../core/lib/timezone');
const Booking = require('../models/Booking');
const { localToUtc } = require('../lib/availability');
const { addDaysToDate } = require('../lib/schedule');
const { computeInsights } = require('../lib/insights');

const HISTORY_DAYS = 365;

async function getInsights(businessId, from, to, compare = null, now = new Date()) {
  const business = await Business.findById(businessId).select('timezone').lean();
  const timezone = businessTimezone(business);
  const oldest = compare && compare.from < from ? compare.from : from;
  const bookings = await Booking.find({
    businessId,
    start: { $gte: localToUtc(addDaysToDate(oldest, -HISTORY_DAYS), 0, timezone), $lt: localToUtc(addDaysToDate(to, 1), 0, timezone) },
  }).select('customerId guestName guestPhone guestEmail status start end segments source totalPrice').lean();
  return computeInsights({ now, timezone, from, to, compare, bookings });
}

module.exports = { getInsights };
