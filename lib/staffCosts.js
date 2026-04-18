/**
 * Shared staff cost calculation — used by staffController and revenueController.
 *
 * calculateStaffCostForRange(businessId, from, to)
 *   Returns the total staff cost (EUR) for the given date range.
 *   - hourly / per_shift: sums assignment costs falling within [from, to]
 *   - monthly_fixed: prorates each month by the fraction of days that fall in [from, to]
 */

const StaffEmployee   = require('../models/StaffEmployee');
const StaffCompensation = require('../models/StaffCompensation');
const StaffAssignment = require('../models/StaffAssignment');
const Shift           = require('../models/Shift');

// ── Helpers (mirrors staffController) ────────────────────────────────────────

function isValidTime(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
}

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function assignmentMinutes(assignment, shiftById) {
  let start = assignment.startTime;
  let end   = assignment.endTime;
  if ((!start || !end) && assignment.shiftId) {
    const shift = shiftById.get(String(assignment.shiftId));
    if (shift) { start = start || shift.startTime; end = end || shift.endTime; }
  }
  if (!isValidTime(start) || !isValidTime(end)) return 0;
  const s = timeToMinutes(start);
  let e   = timeToMinutes(end);
  if (e <= s) e += 24 * 60;
  return Math.max(e - s, 0);
}

function assignmentCost(assignment, comp, shiftById) {
  if (assignment?.customPrice !== null && assignment?.customPrice !== undefined) {
    const p = Number(assignment.customPrice);
    if (Number.isFinite(p) && p >= 0) return Number(p.toFixed(2));
  }
  if (!comp) return 0;
  if (comp.paymentType === 'hourly') {
    const hours = assignmentMinutes(assignment, shiftById) / 60;
    return Number((hours * Number(comp.baseAmount || 0)).toFixed(2));
  }
  if (comp.paymentType === 'per_shift') return Number(Number(comp.baseAmount || 0).toFixed(2));
  return 0;
}

async function getActiveCompensationMap(businessId, employeeIds) {
  if (!employeeIds.length) return new Map();
  const rows = await StaffCompensation.find({
    businessId,
    employeeId: { $in: employeeIds },
    isActive: true,
  }).sort({ effectiveFrom: -1 }).lean();
  const map = new Map();
  rows.forEach((r) => { if (!map.has(String(r.employeeId))) map.set(String(r.employeeId), r); });
  return map;
}

// Returns each calendar month that overlaps [from, to], together with how many
// days of that month fall inside the range (used for monthly_fixed proration).
function monthsInRange(from, to) {
  const result = [];
  const fromD  = new Date(`${from}T12:00:00Z`);
  const toD    = new Date(`${to}T12:00:00Z`);

  let cur = new Date(Date.UTC(fromD.getUTCFullYear(), fromD.getUTCMonth(), 1));
  while (cur <= toD) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth(); // 0-indexed
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const mStart = new Date(Date.UTC(y, m, 1));
    const mEnd   = new Date(Date.UTC(y, m, daysInMonth));
    const rStart = fromD > mStart ? fromD : mStart;
    const rEnd   = toD   < mEnd   ? toD   : mEnd;
    const daysInRange = Math.floor((rEnd - rStart) / 86400000) + 1;
    result.push({ daysInMonth, daysInRange });
    cur = new Date(Date.UTC(y, m + 1, 1)); // advance to next month
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function calculateStaffCostForRange(businessId, from, to) {
  const employees = await StaffEmployee.find({ businessId, status: 'active' }).lean();
  if (!employees.length) return 0;

  const [assignments] = await Promise.all([
    StaffAssignment.find({ businessId, date: { $gte: from, $lte: to } }).lean(),
  ]);

  const shiftIds = [...new Set(assignments.map((a) => a.shiftId).filter(Boolean).map(String))];
  const shifts   = await Shift.find({ _id: { $in: shiftIds }, businessId }).select('startTime endTime').lean();
  const shiftById = new Map(shifts.map((s) => [String(s._id), s]));

  const compensationMap = await getActiveCompensationMap(businessId, employees.map((e) => e._id));
  const months = monthsInRange(from, to);

  const byEmployee = assignments.reduce((acc, a) => {
    const k = String(a.employeeId);
    (acc[k] = acc[k] || []).push(a);
    return acc;
  }, {});

  let total = 0;
  for (const emp of employees) {
    const comp = compensationMap.get(String(emp._id));
    if (!comp) continue;

    if (comp.paymentType === 'hourly' || comp.paymentType === 'per_shift') {
      const rows = byEmployee[String(emp._id)] || [];
      total += rows.reduce((s, a) => s + assignmentCost(a, comp, shiftById), 0);
    } else if (comp.paymentType === 'monthly_fixed') {
      // Prorate per month: fixed_salary × (days_in_range / days_in_month)
      for (const { daysInMonth, daysInRange } of months) {
        total += (Number(comp.baseAmount || 0) * daysInRange) / daysInMonth;
      }
    }
  }

  return Number(total.toFixed(2));
}

module.exports = { calculateStaffCostForRange };
