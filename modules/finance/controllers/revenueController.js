const DailyRevenue = require('../models/DailyRevenue');
const Reservation  = require('../../../verticals/restaurant/models/Reservation');
const Business     = require('../../../core/models/Business');
const Expense      = require('../models/Expense');
const { calculateStaffCostForRange } = require('../../staff/lib/staffCosts');
const { appointmentRevenue } = require('../../bookings/services/revenueService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns today as YYYY-MM-DD in local time (avoids UTC offset shifting the date)
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Generates every date between from and to (inclusive) as YYYY-MM-DD strings.
// Uses noon UTC to avoid DST edge cases when iterating.
function generateDateRange(from, to) {
  const dates = [];
  const cur = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function getTicketAverage(businessId) {
  const biz = await Business.findById(businessId).select('ticketAverage').lean();
  return biz?.ticketAverage ?? 25;
}

// Build per-day estimated revenue from reservations
async function buildEstimatedByDate(businessId, from, to, ticketAverage) {
  const reservations = await Reservation.find({
    businessId,
    date: { $gte: from, $lte: to },
    status: { $in: ['confirmed', 'seated'] },
  }).select('date people').lean();

  const byDate = {};
  for (const r of reservations) {
    if (!byDate[r.date]) byDate[r.date] = { covers: 0, reservations: 0 };
    byDate[r.date].covers += r.people || 0;
    byDate[r.date].reservations += 1;
  }
  return byDate;
}

// ── Controllers ───────────────────────────────────────────────────────────────

// GET /api/revenue/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
async function getDashboard(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'Se requieren los parámetros from y to' });
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return res.status(400).json({ message: 'Fechas no válidas' });

    const biz = await Business.findById(req.businessId).select('businessType').lean();
    if (biz?.businessType === 'appointments') return res.json(await appointmentsDashboard(req.businessId, from, to));

    const ticketAverage = await getTicketAverage(req.businessId);
    const estimatedByDate = await buildEstimatedByDate(req.businessId, from, to, ticketAverage);

    // Actual revenues entered manually
    const actuals = await DailyRevenue.find({
      businessId: req.businessId,
      date: { $gte: from, $lte: to },
    }).lean();
    const actualByDate = {};
    for (const a of actuals) actualByDate[a.date] = a;

    // Expenses in period — exclude 'staff' (comes from the staff module instead)
    const expenses = await Expense.find({
      businessId: req.businessId,
      expenseDate: { $gte: from, $lte: to },
      category: { $ne: 'staff' },
    }).lean();

    // Staff cost calculated directly from the staff module (read-through)
    const staffCost = await calculateStaffCostForRange(req.businessId, from, to);

    // ── Totals ───────────────────────────────────────────────────────────────
    const totalCovers = Object.values(estimatedByDate).reduce((s, d) => s + d.covers, 0);
    const estimatedRevenue = Number((totalCovers * ticketAverage).toFixed(2));

    const totalActual = actuals.reduce((s, a) => s + (a.actualRevenue ?? 0), 0);
    const actualRevenue = actuals.some((a) => a.actualRevenue !== null)
      ? Number(totalActual.toFixed(2))
      : null;

    const manualExpensesTotal = Number(expenses.reduce((s, e) => s + (e.amount || 0), 0).toFixed(2));
    const totalExpenses = Number((manualExpensesTotal + staffCost).toFixed(2));

    const revenueBase = actualRevenue !== null ? actualRevenue : estimatedRevenue;
    const estimatedProfit = Number((revenueBase - totalExpenses).toFixed(2));

    // ── Expenses by category ─────────────────────────────────────────────────
    const byCat = {};
    for (const e of expenses) {
      byCat[e.category] = (byCat[e.category] || 0) + (e.amount || 0);
    }
    // Inject staff cost from the staff module (only if > 0)
    if (staffCost > 0) {
      byCat['staff'] = (byCat['staff'] || 0) + staffCost;
    }
    const expensesByCategory = Object.entries(byCat)
      .map(([category, amount]) => ({ category, amount: Number(amount.toFixed(2)) }))
      .sort((a, b) => b.amount - a.amount);

    // ── Per-day breakdown ────────────────────────────────────────────────────
    // Only show up to today — no future rows
    const today = todayIso();
    const effectiveTo = to > today ? today : to;
    // Every calendar day in range, descending (today first)
    const days = generateDateRange(from, effectiveTo).reverse().map((date) => {
      const est = estimatedByDate[date];
      const act = actualByDate[date];
      return {
        date,
        covers: est?.covers ?? 0,
        reservations: est?.reservations ?? 0,
        estimatedRevenue: est ? Number((est.covers * ticketAverage).toFixed(2)) : 0,
        actualRevenue: act?.actualRevenue ?? null,
        notes: act?.notes ?? '',
      };
    });

    res.json({
      ticketAverage,
      estimatedRevenue,
      actualRevenue,
      totalExpenses,
      estimatedProfit,
      profitBasis: actualRevenue !== null ? 'actual' : 'estimated',
      expensesByCategory,
      totalCovers,
      days,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Appointment businesses: revenue comes from the appointments (what they're
// worth) and the till (what was actually charged); a manual figure for a day
// still wins over the till. Commissions count as an expense.
async function appointmentsDashboard(businessId, from, to) {
  const [revenue, actuals, expenses, staffCost] = await Promise.all([
    appointmentRevenue(businessId, from, to),
    DailyRevenue.find({ businessId, date: { $gte: from, $lte: to } }).lean(),
    Expense.find({ businessId, expenseDate: { $gte: from, $lte: to }, category: { $ne: 'staff' } }).lean(),
    calculateStaffCostForRange(businessId, from, to),
  ]);
  const manualByDate = Object.fromEntries(actuals.map((a) => [a.date, a]));
  const round = (n) => Number(n.toFixed(2));

  const effectiveTo = to > revenue.today ? revenue.today : to;
  let billedTotal = 0; let appointments = 0; let actualTotal = 0; let anyActual = false; let collectedTotal = 0; let tipsTotal = 0;
  const days = generateDateRange(from, effectiveTo).reverse().map((date) => {
    const r = revenue.byDate[date] || { appointments: 0, billed: 0, collected: 0, tips: 0, payments: 0 };
    const manual = manualByDate[date];
    const manualValue = manual?.actualRevenue ?? null;
    const actual = manualValue !== null ? manualValue : (r.payments > 0 ? r.collected : null);
    billedTotal += r.billed; appointments += r.appointments; collectedTotal += r.collected; tipsTotal += r.tips;
    if (actual !== null) { actualTotal += actual; anyActual = true; }
    return {
      date,
      appointments: r.appointments,
      estimatedRevenue: r.billed,
      collected: r.payments > 0 ? r.collected : null,
      tips: r.tips,
      manualRevenue: manualValue,
      actualRevenue: actual,
      actualSource: manualValue !== null ? 'manual' : (r.payments > 0 ? 'till' : null),
      notes: manual?.notes ?? '',
    };
  });

  const commissions = revenue.byStaff.reduce((s, x) => s + x.commission, 0);
  const byCat = {};
  for (const e of expenses) byCat[e.category] = (byCat[e.category] || 0) + (e.amount || 0);
  if (staffCost > 0) byCat.staff = (byCat.staff || 0) + staffCost;
  if (commissions > 0) byCat.commissions = (byCat.commissions || 0) + commissions;
  const expensesByCategory = Object.entries(byCat)
    .map(([category, amount]) => ({ category, amount: round(amount) }))
    .sort((a, b) => b.amount - a.amount);
  const totalExpenses = round(expensesByCategory.reduce((s, c) => s + c.amount, 0));
  const actualRevenue = anyActual ? round(actualTotal) : null;
  const revenueBase = actualRevenue !== null ? actualRevenue : round(billedTotal);

  return {
    mode: 'appointments',
    estimatedRevenue: round(billedTotal),
    actualRevenue,
    collectedRevenue: round(collectedTotal),
    tips: round(tipsTotal),
    totalExpenses,
    estimatedProfit: round(revenueBase - totalExpenses),
    profitBasis: actualRevenue !== null ? 'actual' : 'estimated',
    appointments,
    averageTicket: appointments ? round(billedTotal / appointments) : 0,
    expensesByCategory,
    byStaff: revenue.byStaff,
    days,
  };
}

// PUT /api/revenue/actual  { date, actualRevenue, notes }
async function upsertActual(req, res) {
  try {
    const { date, actualRevenue, notes } = req.body;
    if (!date || !DATE_RE.test(date)) return res.status(400).json({ message: 'Fecha inválida' });

    const doc = await DailyRevenue.findOneAndUpdate(
      { businessId: req.businessId, date },
      {
        actualRevenue: actualRevenue !== '' && actualRevenue !== null
          ? Number(actualRevenue)
          : null,
        notes: notes || '',
      },
      { upsert: true, new: true },
    );
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// PUT /api/revenue/ticket-average  { ticketAverage }
async function updateTicketAverage(req, res) {
  try {
    const { ticketAverage } = req.body;
    const val = Number(ticketAverage);
    if (isNaN(val) || val < 0) return res.status(400).json({ message: 'Valor inválido' });

    await Business.findByIdAndUpdate(req.businessId, { ticketAverage: val });
    res.json({ ticketAverage: val });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = { getDashboard, upsertActual, updateTicketAverage };
