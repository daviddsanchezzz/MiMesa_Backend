/**
 * Appointment reminders: every 15 minutes, email customers whose appointment
 * starts within the next 24 hours and who haven't been reminded yet.
 *
 * - Bookings made less than REMINDER_MIN_LEAD before the appointment are
 *   skipped (they just got the confirmation email).
 * - Each booking is claimed atomically (reminderSentAt set before sending),
 *   so two server instances can never send the same reminder twice.
 */
const Booking = require('../models/Booking');
const { registerJob } = require('../../../core/services/scheduler');
const { sendBookingReminder } = require('../services/bookingEmails');

const HOUR = 60 * 60 * 1000;
const REMINDER_WINDOW = 24 * HOUR;      // remind when the appointment is at most 24h away
const REMINDER_MIN_LEAD = 12 * HOUR;    // …but only if it was booked at least 12h before
const BATCH = 200;

async function runBookingReminders(now = new Date()) {
  const candidates = await Booking.find({
    status: 'confirmed',
    reminderSentAt: null,
    guestEmail: { $nin: [null, ''] },
    start: { $gt: now, $lte: new Date(now.getTime() + REMINDER_WINDOW) },
  }).select('_id start createdAt').limit(BATCH).lean();

  let sent = 0;
  for (const c of candidates) {
    if (c.start.getTime() - new Date(c.createdAt).getTime() < REMINDER_MIN_LEAD) {
      // Booked at the last minute: mark as handled so we don't look at it again.
      await Booking.updateOne({ _id: c._id, reminderSentAt: null }, { $set: { reminderSentAt: new Date(0) } });
      continue;
    }
    const claimed = await Booking.findOneAndUpdate(
      { _id: c._id, status: 'confirmed', reminderSentAt: null },
      { $set: { reminderSentAt: now } },
      { new: true },
    );
    if (!claimed) continue; // another instance got it, or it changed meanwhile
    const ok = await sendBookingReminder(claimed);
    if (ok) sent++;
    else await Booking.updateOne({ _id: c._id, reminderSentAt: now }, { $set: { reminderSentAt: null } }); // retry next run
  }
  if (candidates.length) console.log(`[scheduler] booking reminders: ${sent} sent, ${candidates.length} checked`);
  return { sent, checked: candidates.length };
}

registerJob({
  schedule: '*/15 * * * *',
  run: () => runBookingReminders(),
  failureLabel: 'booking reminders',
  startedLog: 'started booking reminder job (every 15 minutes)',
});

module.exports = { runBookingReminders, REMINDER_WINDOW, REMINDER_MIN_LEAD };
