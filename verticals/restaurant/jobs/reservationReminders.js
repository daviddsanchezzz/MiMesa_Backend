const Reservation = require('../models/Reservation');
const ReminderLog = require('../models/ReminderLog');
const Business    = require('../../../core/models/Business');
const { canUseFeature } = require('../../../core/lib/planCapabilities');
const { businessTimezone, zonedDateTimeToUtc, dateInTimezone } = require('../../../core/lib/timezone');
const { registerJob } = require('../../../core/services/scheduler');
const { sendReservationReminderEmail } = require('../services/reservationEmails');

async function runReservationReminders() {
  const businesses = await Business.find({
    subscriptionStatus: { $in: ['active', 'trialing'] },
  }).select('name brandColor email phone plan subscriptionStatus legacyAccess paymentFailedAt trialEndsAt stripeSubscriptionId reminderHoursBefore timezone');

  for (const business of businesses) {
    if (!canUseFeature(business, 'autoReminders')) continue;

    const hours = Number(business.reminderHoursBefore || 24);
    const windowStart = new Date(Date.now() + hours * 60 * 60 * 1000);
    const windowEnd = new Date(windowStart.getTime() + 15 * 60 * 1000);
    const tz = businessTimezone(business);

    const candidates = await Reservation.find({
      businessId: business._id,
      status: 'confirmed',
      guestEmail: { $ne: '' },
      reminderSentAt: null,
      date: { $gte: dateInTimezone(windowStart, tz), $lte: dateInTimezone(windowEnd, tz) },
    }).select('_id date time guestEmail guestName people status reminderSentAt');

    for (const reservation of candidates) {
      const reservationDateTime = zonedDateTimeToUtc(reservation.date, reservation.time, tz);
      if (reservationDateTime < windowStart || reservationDateTime >= windowEnd) continue;

      try {
        await ReminderLog.create({
          businessId: business._id,
          reservationId: reservation._id,
          type: 'reservation_reminder',
          status: 'sent',
        });
      } catch (err) {
        // Duplicate key => already logged by another run/instance.
        if (err?.code === 11000) continue;
        await ReminderLog.create({
          businessId: business._id,
          reservationId: reservation._id,
          type: 'reservation_reminder',
          status: 'failed',
          error: err.message || 'Failed before send',
        }).catch(() => {});
        continue;
      }

      try {
        const fresh = await Reservation.findOne({ _id: reservation._id, status: 'confirmed' });
        if (!fresh) continue;
        await sendReservationReminderEmail(fresh, business);
        await Reservation.updateOne({ _id: reservation._id, reminderSentAt: null }, { $set: { reminderSentAt: new Date() } });
      } catch (err) {
        await ReminderLog.updateOne(
          { reservationId: reservation._id, type: 'reservation_reminder' },
          { $set: { status: 'failed', error: err.message || 'Failed to send reminder' } }
        ).catch(() => {});
      }
    }
  }
}

// Reservation reminders: every 15 minutes
registerJob({
  schedule: '*/15 * * * *',
  run: runReservationReminders,
  failureLabel: 'reservation reminders',
  startedLog: 'started reservation reminder job (every 15 minutes)',
});

module.exports = { runReservationReminders };
