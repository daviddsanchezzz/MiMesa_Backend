const cron = require('node-cron');
const Reservation = require('../models/Reservation');
const Business = require('../models/Business');
const ReminderLog = require('../models/ReminderLog');
const { canUseFeature } = require('../lib/planCapabilities');
const { sendReservationReminderEmail } = require('./email');

let started = false;

function parseDateTime(date, time) {
  return new Date(`${date}T${time}:00`);
}

async function runReservationReminders() {
  const businesses = await Business.find({
    subscriptionStatus: { $in: ['active', 'trialing'] },
    plan: { $in: ['pro'] },
  }).select('name brandColor email phone plan subscriptionStatus reminderHoursBefore');

  for (const business of businesses) {
    if (!canUseFeature(business, 'autoReminders')) continue;

    const hours = Number(business.reminderHoursBefore || 24);
    const windowStart = new Date(Date.now() + hours * 60 * 60 * 1000);
    const windowEnd = new Date(windowStart.getTime() + 15 * 60 * 1000);

    const candidates = await Reservation.find({
      businessId: business._id,
      status: 'confirmed',
      guestEmail: { $ne: '' },
      reminderSentAt: null,
    }).select('_id date time guestEmail guestName people status reminderSentAt');

    for (const reservation of candidates) {
      const reservationDateTime = parseDateTime(reservation.date, reservation.time);
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

function startSchedulers() {
  if (started) return;
  started = true;
  cron.schedule('*/15 * * * *', () => {
    runReservationReminders().catch((err) => {
      console.error('[scheduler] reservation reminders failed:', err.message);
    });
  });
  console.log('[scheduler] started reservation reminder job (every 15 minutes)');
}

module.exports = {
  startSchedulers,
  runReservationReminders,
};
