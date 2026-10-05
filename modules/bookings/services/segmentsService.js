/**
 * Loads a business's customers and their bookings and works out who is in a segment.
 */
const Customer = require('../../../core/models/Customer');
const Booking = require('../models/Booking');
const { computeSegment } = require('../lib/segments');

const HISTORY_DAYS = 3 * 365;

async function getSegment(businessId, type, params, now = new Date()) {
  const [customers, bookings] = await Promise.all([
    Customer.find({ businessId }).select('name email marketingSubscribed marketingUnsubscribed').lean(),
    Booking.find({ businessId, customerId: { $ne: null }, start: { $gte: new Date(now.getTime() - HISTORY_DAYS * 86400000) } })
      .select('customerId status start end segments.serviceId').lean(),
  ]);
  return computeSegment({ type, params, customers, bookings, now });
}

module.exports = { getSegment };
