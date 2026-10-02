/**
 * Team of an appointment business, joined with the staff module: every
 * professional of the agenda gets a staff record (for pay and payments), and
 * the report adds up what each one billed and cost.
 */
const mongoose = require('mongoose');
const Business = require('../../../core/models/Business');
const { businessTimezone, dateInTimezone } = require('../../../core/lib/timezone');
const Resource = require('../models/Resource');
const Schedule = require('../models/Schedule');
const Service = require('../models/Service');
const Booking = require('../models/Booking');
const StaffEmployee = require('../../staff/models/StaffEmployee');
const StaffCompensation = require('../../staff/models/StaffCompensation');
const StaffPayment = require('../../staff/models/StaffPayment');
const { localToUtc } = require('../lib/availability');
const { addDaysToDate } = require('../lib/schedule');
const { computeTeam } = require('../lib/team');
const { BookingError } = require('../lib/errors');

/** Creates the missing staff records for the agenda's professionals. */
async function ensureEmployees(businessId) {
  const staff = await Resource.find({ businessId, kind: 'staff', staffEmployeeId: null }).lean();
  for (const r of staff) {
    const [firstName, ...rest] = String(r.name).trim().split(/\s+/);
    const emp = await StaffEmployee.create({ businessId, firstName: firstName || r.name, lastName: rest.join(' '), status: r.active === false ? 'inactive' : 'active' });
    await Resource.updateOne({ _id: r._id, staffEmployeeId: null }, { staffEmployeeId: emp._id });
  }
}

async function teamReport(businessId, from, to, now = new Date(), { ensure = true } = {}) {
  if (ensure) await ensureEmployees(businessId);
  const business = await Business.findById(businessId).select('timezone').lean();
  const tz = businessTimezone(business);
  const [staff, schedules, services, bookings] = await Promise.all([
    Resource.find({ businessId, kind: 'staff' }).select('name color photo active staffEmployeeId sortOrder').sort({ sortOrder: 1, name: 1 }).lean(),
    Schedule.find({ businessId }).lean(),
    Service.find({ businessId }).select('staffCommissionPercent').lean(),
    Booking.find({ businessId, start: { $gte: localToUtc(from, 0, tz), $lt: localToUtc(addDaysToDate(to, 1), 0, tz) } })
      .select('status start end segments payment').lean(),
  ]);
  const employeeIds = staff.map((s) => s.staffEmployeeId).filter(Boolean);
  const [comps, paid] = await Promise.all([
    StaffCompensation.find({ businessId, employeeId: { $in: employeeIds }, isActive: true }).sort({ effectiveFrom: -1 }).lean(),
    StaffPayment.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), employeeId: { $in: employeeIds }, paidAt: { $gte: localToUtc(from, 0, tz), $lt: localToUtc(addDaysToDate(to, 1), 0, tz) } } },
      { $group: { _id: '$employeeId', amount: { $sum: '$amount' } } },
    ]),
  ]);
  const compensations = {};
  for (const c of comps) if (!compensations[String(c.employeeId)]) compensations[String(c.employeeId)] = c;
  const payments = Object.fromEntries(paid.map((p) => [String(p._id), p.amount]));
  const businessSchedule = schedules.find((s) => s.ownerType === 'business') || null;
  const resourceSchedules = {};
  for (const s of schedules) if (s.ownerType === 'resource') resourceSchedules[String(s.ownerId)] = s;
  const serviceCommission = Object.fromEntries(services.map((s) => [String(s._id), s.staffCommissionPercent ?? null]));
  const report = computeTeam({ staff, compensations, serviceCommission, bookings, payments, businessSchedule, resourceSchedules, from, to, now });
  return { from, to, today: dateInTimezone(now, tz), ...report };
}

const PAY_TYPES = { monthly: 'monthly_fixed', hourly: 'hourly', commission: 'commission_only' };

async function employeeFor(businessId, resourceId) {
  await ensureEmployees(businessId);
  const r = await Resource.findOne({ _id: resourceId, businessId, kind: 'staff' }).lean();
  if (!r) throw new BookingError(404, 'Profesional no encontrado', 'NOT_FOUND');
  return { resource: r, employeeId: r.staffEmployeeId };
}

function pct(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new BookingError(400, `${label} debe estar entre 0 y 100`, 'BAD_REQUEST');
  return Math.round(n * 100) / 100;
}

async function setPay(businessId, resourceId, body = {}, today) {
  const { employeeId } = await employeeFor(businessId, resourceId);
  const paymentType = PAY_TYPES[body.type];
  if (!paymentType) throw new BookingError(400, 'Elige cómo cobra: sueldo fijo, por horas o solo comisión', 'BAD_REQUEST');
  const baseAmount = paymentType === 'commission_only' ? 0 : Number(body.amount);
  if (!Number.isFinite(baseAmount) || baseAmount < 0 || baseAmount > 100000) throw new BookingError(400, 'El importe no es válido', 'BAD_REQUEST');
  const commissionPercent = pct(body.commissionPercent, 'La comisión');
  const productCommissionPercent = pct(body.productCommissionPercent, 'La comisión de productos');
  await StaffCompensation.updateMany({ businessId, employeeId, isActive: true }, { $set: { isActive: false } });
  return StaffCompensation.create({
    businessId, employeeId, paymentType, baseAmount, commissionPercent, productCommissionPercent,
    effectiveFrom: today, isActive: true,
  });
}

async function addPayment(businessId, resourceId, body = {}) {
  const { employeeId } = await employeeFor(businessId, resourceId);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new BookingError(400, 'El importe no es válido', 'BAD_REQUEST');
  return StaffPayment.create({ businessId, employeeId, amount: Math.round(amount * 100) / 100, notes: String(body.notes || '').slice(0, 300), paidAt: new Date() });
}

module.exports = { teamReport, setPay, addPayment, ensureEmployees };
