const Expense          = require('../models/Expense');
const RecurringExpense = require('../models/RecurringExpense');
const Business         = require('../../../core/models/Business');
const { canUseModule } = require('../../../core/lib/planCapabilities');
const { registerJob }  = require('../../../core/services/scheduler');

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
  }).select('plan subscriptionStatus moduleOverrides businessType').lean();

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

// Recurring expenses: every day at 05:00
registerJob({
  schedule: '0 5 * * *',
  run: generateRecurringExpenses,
  failureLabel: 'recurring expenses',
  startedLog: 'started recurring expenses job (daily at 05:00)',
});

module.exports = { generateRecurringExpenses };
