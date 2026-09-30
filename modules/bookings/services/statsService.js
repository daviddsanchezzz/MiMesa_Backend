/**
 * Loads what the dashboard needs and hands it to the pure stats calculator.
 */
const Business = require('../../../core/models/Business');
const { businessTimezone } = require('../../../core/lib/timezone');
const Resource = require('../models/Resource');
const Schedule = require('../models/Schedule');
const Booking = require('../models/Booking');
const { computeStats } = require('../lib/stats');

const DAY = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 365; // enough to know who is new and who is due back

async function getDashboardStats(businessId, now = new Date()) {
  const business = await Business.findById(businessId).select('timezone').lean();
  const timezone = businessTimezone(business);
  const [staff, schedules, bookings] = await Promise.all([
    Resource.find({ businessId, active: true, kind: 'staff' }).select('name color sortOrder').sort({ sortOrder: 1, name: 1 }).lean(),
    Schedule.find({ businessId }).lean(),
    Booking.find({
      businessId,
      start: { $gte: new Date(now.getTime() - HISTORY_DAYS * DAY), $lt: new Date(now.getTime() + 9 * DAY) },
    }).select('customerId guestName guestPhone guestEmail status start end segments source totalPrice cancelledAt reminderSentAt').lean(),
  ]);
  const businessSchedule = schedules.find((s) => s.ownerType === 'business') || null;
  const resourceSchedules = {};
  for (const s of schedules) if (s.ownerType === 'resource') resourceSchedules[String(s.ownerId)] = s;
  return computeStats({ now, timezone, staff, businessSchedule, resourceSchedules, bookings });
}

module.exports = { getDashboardStats };
