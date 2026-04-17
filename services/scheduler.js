const cron = require('node-cron');
const Reservation = require('../models/Reservation');
const Business    = require('../models/Business');
const ReminderLog = require('../models/ReminderLog');
const Expense          = require('../models/Expense');
const RecurringExpense = require('../models/RecurringExpense');
const { canUseFeature, canUseModule } = require('../lib/planCapabilities');
const { sendReservationReminderEmail } = require('./email');

let started = false;

function parseDateTime(date, time) {
  return new Date(`${date}T${time}:00`);
}

async function runReservationReminders() {
  const businesses = await Business.find({
    subscriptionStatus: { $in: ['active', 'trialing'] },
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

// ── Recurring expenses ────────────────────────────────────────────────────────
// Runs daily. For each active template whose dayOfMonth <= today's day,
// creates an expense for this month if one hasn't been generated yet.
// If the server was down on the 4th and restarts on the 6th, the expense is
// still created — with expenseDate set to the 4th (the correct accounting date).

async function generateRecurringExpenses() {
  const now          = new Date();
  const todayDay     = now.getDate();                                   // e.g. 6
  const curYear      = now.getFullYear();
  const curMonthNum  = String(now.getMonth() + 1).padStart(2, '0');
  const daysInMonth  = new Date(curYear, now.getMonth() + 1, 0).getDate();
  const monthStart   = `${curYear}-${curMonthNum}-01`;
  const monthEnd     = `${curYear}-${curMonthNum}-${String(daysInMonth).padStart(2, '0')}`;

  // Only businesses with an active/trialing subscription
  const businesses = await Business.find({
    subscriptionStatus: { $in: ['active', 'trialing'] },
  }).select('plan subscriptionStatus moduleOverrides').lean();

  let created = 0;
  let skipped = 0;

  for (const business of businesses) {
    if (!canUseModule(business, 'expenses')) continue;

    // Templates whose day has already passed (or is today) this month
    const templates = await RecurringExpense.find({
      businessId: business._id,
      isActive:   true,
      dayOfMonth: { $lte: todayDay },
    }).lean();

    for (const tpl of templates) {
      // Already generated this month for this template?
      const exists = await Expense.findOne({
        businessId:         business._id,
        recurringExpenseId: tpl._id,
        expenseDate:        { $gte: monthStart, $lte: monthEnd },
      }).lean();

      if (exists) { skipped++; continue; }

      // Use the template's dayOfMonth as the accounting date (capped to month length)
      const day        = Math.min(tpl.dayOfMonth, daysInMonth);
      const targetDate = `${curYear}-${curMonthNum}-${String(day).padStart(2, '0')}`;

      await Expense.create({
        businessId:         tpl.businessId,
        supplierId:         tpl.supplierId ?? null,
        category:           tpl.category,
        amount:             tpl.amount,
        currency:           tpl.currency || 'EUR',
        expenseDate:        targetDate,
        notes:              tpl.notes || '',
        attachmentUrl:      '',
        isRecurring:        true,
        recurringExpenseId: tpl._id,
        createdBy:          'system',
      });
      created++;
    }
  }

  console.log(`[scheduler] recurring expenses: ${created} created, ${skipped} skipped`);
}

function startSchedulers() {
  if (started) return;
  started = true;
  // Reservation reminders: every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    runReservationReminders().catch((err) => {
      console.error('[scheduler] reservation reminders failed:', err.message);
    });
  });
  console.log('[scheduler] started reservation reminder job (every 15 minutes)');

  // Recurring expenses: every day at 05:00
  cron.schedule('0 5 * * *', () => {
    generateRecurringExpenses().catch((err) => {
      console.error('[scheduler] recurring expenses failed:', err.message);
    });
  });
  console.log('[scheduler] started recurring expenses job (daily at 05:00)');
}

module.exports = {
  startSchedulers,
  runReservationReminders,
  generateRecurringExpenses,
};
