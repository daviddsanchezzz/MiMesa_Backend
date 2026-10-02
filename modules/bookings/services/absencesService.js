/**
 * Absences of professionals. Anyone can block their own agenda (the
 * professional linked to their user); managers can block anybody's.
 * An absence cannot be created over appointments that are still to happen:
 * they must be moved to someone else (or cancelled) first.
 */
const Business = require('../../../core/models/Business');
const BusinessMember = require('../../../core/models/BusinessMember');
const { businessTimezone } = require('../../../core/lib/timezone');
const Resource = require('../models/Resource');
const Booking = require('../models/Booking');
const Absence = require('../models/Absence');
const { BookingError } = require('../lib/errors');
const { localToUtc } = require('../lib/availability');
const { toMinutes, addDaysToDate } = require('../lib/schedule');

const OPEN_STATUSES = ['pending', 'confirmed', 'checked_in'];
const HIERARCHY = { owner: 3, manager: 2, staff: 1 };

async function roleOf(req) {
  if (req.memberRole) return req.memberRole;
  const m = await BusinessMember.findOne({ userId: req.user?.id, businessId: req.businessId }).select('role').lean();
  return m?.role || null;
}

const isManager = (role) => (HIERARCHY[role] || 0) >= HIERARCHY.manager;

async function timezoneOf(businessId) {
  const b = await Business.findById(businessId).select('timezone').lean();
  return businessTimezone(b);
}

function interval(input, tz) {
  if (input.allDay) {
    return { start: localToUtc(input.fromDate, 0, tz), end: localToUtc(addDaysToDate(input.toDate, 1), 0, tz) };
  }
  return { start: localToUtc(input.fromDate, toMinutes(input.startTime), tz), end: localToUtc(input.fromDate, toMinutes(input.endTime), tz) };
}

/** Appointments still to happen that use this professional inside [start, end). */
async function conflictsFor(businessId, resourceId, start, end) {
  const rid = String(resourceId);
  const list = await Booking.find({
    businessId, status: { $in: OPEN_STATUSES }, start: { $lt: end }, end: { $gt: start }, 'segments.resourceIds': resourceId,
  }).select('guestName start end status segments').sort({ start: 1 }).lean();
  return list
    .filter((b) => b.segments.some((s) => (s.resourceIds || []).some((id) => String(id) === rid) && s.start < end && s.end > start))
    .map((b) => ({
      _id: b._id, guestName: b.guestName, start: b.start, end: b.end, status: b.status,
      services: b.segments.map((s) => s.serviceName).join(' + '),
    }));
}

async function canManageResource(req, resource) {
  const role = await roleOf(req);
  if (isManager(role)) return true;
  return !!resource.userId && resource.userId === req.user?.id;
}

async function createAbsence(req, input) {
  const resource = await Resource.findOne({ _id: input.resourceId, businessId: req.businessId, kind: 'staff' }).lean();
  if (!resource) throw new BookingError(404, 'Profesional no encontrado', 'NOT_FOUND');
  if (!(await canManageResource(req, resource))) {
    throw new BookingError(403, 'Solo puedes bloquear tu propia agenda', 'FORBIDDEN');
  }
  const tz = await timezoneOf(req.businessId);
  const { start, end } = interval(input, tz);
  const conflicts = await conflictsFor(req.businessId, resource._id, start, end);
  if (conflicts.length) {
    throw new BookingError(409, conflicts.length === 1
      ? `${resource.name} tiene 1 cita en ese tiempo. Pásala a otra persona o cancélala antes de bloquear.`
      : `${resource.name} tiene ${conflicts.length} citas en ese tiempo. Pásalas a otra persona o cancélalas antes de bloquear.`,
    'HAS_BOOKINGS', { bookings: conflicts });
  }
  const doc = await Absence.create({ ...input, businessId: req.businessId, start, end, createdBy: req.user?.id || null });
  return shape(doc.toObject(), true);
}

function shape(a, showReason) {
  return {
    _id: a._id, resourceId: a.resourceId, start: a.start, end: a.end, allDay: a.allDay,
    fromDate: a.fromDate, toDate: a.toDate, startTime: a.startTime, endTime: a.endTime,
    reason: showReason ? a.reason : '', createdBy: a.createdBy,
  };
}

async function listAbsences(req, { from, to }) {
  const tz = await timezoneOf(req.businessId);
  const [role, resources, list] = await Promise.all([
    roleOf(req),
    Resource.find({ businessId: req.businessId, kind: 'staff' }).select('userId').lean(),
    Absence.find({ businessId: req.businessId, start: { $lt: localToUtc(addDaysToDate(to, 1), 0, tz) }, end: { $gt: localToUtc(from, 0, tz) } })
      .sort({ start: 1 }).lean(),
  ]);
  const mine = new Set(resources.filter((r) => r.userId && r.userId === req.user?.id).map((r) => String(r._id)));
  return list.map((a) => shape(a, isManager(role) || mine.has(String(a.resourceId))));
}

async function deleteAbsence(req, id) {
  const a = await Absence.findOne({ _id: id, businessId: req.businessId }).lean();
  if (!a) throw new BookingError(404, 'Ausencia no encontrada', 'NOT_FOUND');
  const resource = await Resource.findById(a.resourceId).lean();
  if (!resource || !(await canManageResource(req, resource))) {
    throw new BookingError(403, 'Solo puedes quitar tus propias ausencias', 'FORBIDDEN');
  }
  await Absence.deleteOne({ _id: a._id });
}

module.exports = { createAbsence, listAbsences, deleteAbsence, conflictsFor };
