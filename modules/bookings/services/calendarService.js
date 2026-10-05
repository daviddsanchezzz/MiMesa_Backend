/**
 * Calendar feed (.ics) of a professional: the secret link that Google/Apple
 * Calendar subscribe to, and the feed itself.
 */
const crypto = require('crypto');
const Business = require('../../../core/models/Business');
const Resource = require('../models/Resource');
const Booking = require('../models/Booking');
const { BookingError } = require('../lib/errors');
const { buildCalendar } = require('../lib/ics');

const DAY = 24 * 60 * 60 * 1000;
const PAST_DAYS = 30;
const FUTURE_DAYS = 180;
const SHOWN = ['pending', 'confirmed', 'checked_in', 'completed'];

const newToken = () => crypto.randomBytes(24).toString('hex');

/** The professional's secret feed token, created the first time. `reset` makes the old link stop working. */
async function tokenFor(businessId, resourceId, { reset = false } = {}) {
  const resource = await Resource.findOne({ _id: resourceId, businessId, kind: 'staff' }).select('+calendarToken').lean();
  if (!resource) throw new BookingError(404, 'Profesional no encontrado', 'NOT_FOUND');
  if (resource.calendarToken && !reset) return resource.calendarToken;
  const token = newToken();
  await Resource.updateOne({ _id: resourceId }, { $set: { calendarToken: token } });
  return token;
}

/** .ics text for a token, or null when it does not exist. */
async function feedFor(token, now = new Date()) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const resource = await Resource.findOne({ calendarToken: token, kind: 'staff', active: true }).select('+calendarToken name businessId').lean();
  if (!resource) return null;
  const business = await Business.findById(resource.businessId).select('name address').lean();
  const bookings = await Booking.find({
    businessId: resource.businessId,
    status: { $in: SHOWN },
    'segments.resourceIds': resource._id,
    start: { $gte: new Date(now.getTime() - PAST_DAYS * DAY), $lte: new Date(now.getTime() + FUTURE_DAYS * DAY) },
  }).select('guestName guestPhone notes status segments updatedAt').lean();

  const events = [];
  for (const b of bookings) {
    for (const seg of b.segments) {
      if (!(seg.resourceIds || []).some((id) => String(id) === String(resource._id))) continue;
      events.push({
        uid: `${b._id}-${seg._id}@vetra`,
        start: seg.start,
        end: seg.end,
        summary: `${b.guestName} · ${seg.serviceName}`,
        description: [seg.serviceName, b.guestPhone && `Tel. ${b.guestPhone}`, b.notes].filter(Boolean).join('\n'),
        location: business?.address || '',
        status: b.status === 'pending' ? 'tentative' : 'confirmed',
        updated: b.updatedAt,
      });
    }
  }
  return buildCalendar({ name: `${resource.name} · ${business?.name || 'Agenda'}`, events, now });
}

module.exports = { tokenFor, feedFor };
