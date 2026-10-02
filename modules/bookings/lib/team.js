/**
 * Team report for appointment businesses: per professional, what they billed,
 * sold and earned in tips, what they cost (salary + commission) and what is
 * left for the business. Pure; euros in, euros out (bookings are in cents).
 */
const { windowsForDate, intersect, datesBetween } = require('./schedule');

const round = (n) => Math.round(n * 100) / 100;
const CANCELLED = new Set(['cancelled', 'no_show', 'pending']);

function monthsFraction(from, to) {
  // Σ over the months touched of (days in range / days in month): 1 = one full month
  let total = 0;
  for (const d of datesBetween(from, to, 400)) {
    const [y, m] = d.split('-').map(Number);
    total += 1 / new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  return total;
}

function scheduledMinutes(resourceId, dates, businessSchedule, resourceSchedules) {
  let total = 0;
  for (const d of dates) {
    const biz = windowsForDate(businessSchedule, d);
    const own = resourceSchedules[resourceId];
    const win = own ? intersect(windowsForDate(own, d), biz) : biz;
    total += win.reduce((s, [a, b]) => s + (b - a), 0);
  }
  return total;
}

/**
 * @param p.staff          [{ _id, name, color, photo, active, staffEmployeeId }]
 * @param p.compensations  { [employeeId]: { paymentType, baseAmount, commissionPercent, productCommissionPercent } }
 * @param p.serviceCommission { [serviceId]: percent|null }
 * @param p.bookings       bookings in range (cents), with payment when charged
 * @param p.payments       { [employeeId]: euros paid to them in the range }
 */
function computeTeam({ staff, compensations = {}, serviceCommission = {}, bookings = [], payments = {}, businessSchedule, resourceSchedules = {}, from, to, now = new Date() }) {
  const dates = datesBetween(from, to, 400);
  const months = monthsFraction(from, to);
  const rows = new Map(staff.map((s) => [String(s._id), {
    id: String(s._id), name: s.name, color: s.color || null, photo: s.photo || null, active: s.active !== false,
    employeeId: s.staffEmployeeId ? String(s.staffEmployeeId) : null,
    appointments: 0, billed: 0, products: 0, tips: 0, commission: 0, salary: 0, hours: 0, paid: 0,
  }]));
  const pay = (id) => (rows.get(id)?.employeeId && compensations[rows.get(id).employeeId]) || null;

  for (const b of bookings) {
    if (CANCELLED.has(b.status)) continue;
    const attended = b.status === 'completed' || b.status === 'checked_in' || new Date(b.end) <= now;
    if (!attended) continue;
    const touched = new Set();
    for (const seg of b.segments || []) {
      const ids = (seg.resourceIds || []).map(String).filter((id) => rows.has(id));
      for (const id of ids) {
        const row = rows.get(id);
        const share = (seg.price || 0) / 100 / ids.length;
        row.billed += share;
        const own = serviceCommission[String(seg.serviceId)];
        const pct = own !== null && own !== undefined ? own : (pay(id)?.commissionPercent || 0);
        row.commission += share * pct / 100;
        if (!touched.has(id)) { row.appointments += 1; touched.add(id); }
      }
    }
    // Products and tips go to the first professional of the appointment
    const first = [...touched][0];
    if (first && b.payment) {
      const row = rows.get(first);
      const products = (b.payment.extras || []).reduce((s, x) => s + x.price * x.qty, 0) / 100;
      row.products += products;
      row.commission += products * (pay(first)?.productCommissionPercent || 0) / 100;
      row.tips += (b.payment.tip || 0) / 100;
    }
  }

  for (const row of rows.values()) {
    const comp = pay(row.id);
    const minutes = scheduledMinutes(row.id, dates, businessSchedule, resourceSchedules);
    row.hours = round(minutes / 60);
    if (comp?.paymentType === 'monthly_fixed') row.salary = (comp.baseAmount || 0) * months;
    else if (comp?.paymentType === 'hourly') row.salary = (comp.baseAmount || 0) * (minutes / 60);
    row.paid = row.employeeId ? (payments[row.employeeId] || 0) : 0;
    row.pay = comp ? {
      type: comp.paymentType, amount: comp.baseAmount || 0,
      commissionPercent: comp.commissionPercent ?? null, productCommissionPercent: comp.productCommissionPercent ?? null,
    } : null;
  }

  const out = [...rows.values()]
    .filter((r) => r.active || r.billed > 0 || r.paid > 0)
    .map((r) => {
      const cost = r.salary + r.commission;
      return {
        ...r,
        billed: round(r.billed), products: round(r.products), tips: round(r.tips), commission: round(r.commission),
        salary: round(r.salary), paid: round(r.paid), cost: round(cost),
        leaves: round(r.billed + r.products - cost),      // what the business keeps
        toPay: round(Math.max(0, cost + r.tips - r.paid)), // salary + commission + tips not paid yet
      };
    });
  const totals = out.reduce((t, r) => {
    for (const k of ['appointments', 'billed', 'products', 'tips', 'commission', 'salary', 'cost', 'leaves', 'paid', 'toPay', 'hours']) t[k] = round((t[k] || 0) + r[k]);
    return t;
  }, {});
  return { staff: out, totals };
}

module.exports = { computeTeam, monthsFraction, scheduledMinutes };
