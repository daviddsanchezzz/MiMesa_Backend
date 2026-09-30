/**
 * Booking use cases on top of MongoDB: load what the availability engine
 * needs, create bookings (occupying resources atomically) and cancel them.
 */
const mongoose = require('mongoose');
const Business = require('../../../core/models/Business');
const Customer = require('../../../core/models/Customer');
const { acquireLock } = require('../../../core/lib/keyedLock');
const { businessTimezone, dateInTimezone } = require('../../../core/lib/timezone');
const { toStoredNormalizedPhone, getPhoneMatchCandidates } = require('../../../core/lib/phoneMatching');
const Resource = require('../models/Resource');
const Schedule = require('../models/Schedule');
const Service = require('../models/Service');
const Booking = require('../models/Booking');
const Occupancy = require('../models/Occupancy');
const Absence = require('../models/Absence');
const { createContext, evaluateStart, findSlots } = require('../lib/availability');
const { cellsFor, isAligned } = require('../lib/occupancy');
const { toMinutes, addDaysToDate } = require('../lib/schedule');
const { BookingError } = require('../lib/errors');
const { getCapabilities, PLAN_FIELDS } = require('../../../core/lib/planCapabilities');
const { lockedStaff } = require('../lib/planLimits');

// Statuses whose segments keep their resources busy.
const ACTIVE_STATUSES = ['pending', 'confirmed', 'checked_in', 'completed'];
const DAY_MS = 24 * 60 * 60 * 1000;

const REASON_MESSAGES = {
  closed: 'El negocio no está abierto en ese horario',
  no_resource: 'No hay disponibilidad en ese horario',
  notice: 'No se puede reservar con tan poca antelación',
  too_far: 'Aún no se puede reservar para esa fecha',
  online_disabled: 'Este servicio no se puede reservar online',
  party_size: 'Número de personas no permitido para este servicio',
  pool_full: 'No queda aforo en ese horario',
  quote_only: 'Este servicio se contrata bajo presupuesto',
  crosses_midnight: 'La cita no puede pasar de medianoche',
  past: 'Esa hora ya ha pasado',
};

async function loadEngineData(businessId, services, fromDate, toDate, { excludeBookingId = null } = {}) {
  const business = await Business.findById(businessId).select(`timezone ${PLAN_FIELDS}`).lean();
  if (!business) throw new BookingError(404, 'Negocio no encontrado', 'NOT_FOUND');
  const timezone = businessTimezone(business);

  const [allResources, schedules] = await Promise.all([
    Resource.find({ businessId, active: true }).lean(),
    Schedule.find({ businessId }).lean(),
  ]);
  // Professionals over the plan limit (after a downgrade) take no new appointments.
  const locked = lockedStaff(allResources, getCapabilities(business));
  const resources = locked.size ? allResources.filter((r) => !locked.has(String(r._id))) : allResources;
  const businessSchedule = schedules.find((s) => s.ownerType === 'business') || null;
  const resourceSchedules = {};
  for (const s of schedules) if (s.ownerType === 'resource') resourceSchedules[String(s.ownerId)] = s;

  // Bookings that may overlap the range (one day of margin for timezones/buffers).
  const rangeStart = new Date(Date.parse(`${fromDate}T00:00:00Z`) - DAY_MS);
  const rangeEnd = new Date(Date.parse(`${toDate}T00:00:00Z`) + 2 * DAY_MS);
  const [bookings, absences] = await Promise.all([
    Booking.find({
      businessId,
      status: { $in: ACTIVE_STATUSES },
      start: { $lt: rangeEnd },
      end: { $gt: rangeStart },
      ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
    }).select('segments partySize').lean(),
    Absence.find({ businessId, start: { $lt: rangeEnd }, end: { $gt: rangeStart } }).select('resourceId start end').lean(),
  ]);

  const busy = [];
  const poolUsageByService = {};
  for (const b of bookings) {
    for (const seg of b.segments) {
      for (const rid of seg.resourceIds || []) busy.push({ resourceId: String(rid), start: seg.busyStart, end: seg.busyEnd });
      const sid = String(seg.serviceId);
      (poolUsageByService[sid] ||= []).push({ start: seg.start, end: seg.end, partySize: b.partySize || 1 });
    }
  }
  // Absences block the professional like an appointment would.
  for (const a of absences) busy.push({ resourceId: String(a.resourceId), start: a.start, end: a.end });
  const contextFor = (service, { online, now = new Date() }) => createContext({
    service, timezone, businessSchedule, resources, resourceSchedules, busy,
    poolUsage: poolUsageByService[String(service._id)] || [], now, online,
  });
  return { timezone, contextFor, services };
}

async function getAvailability({ businessId, serviceId, from, to, partySize = 1, resourceId = null, online }) {
  const service = await Service.findOne({ _id: serviceId, businessId, active: true }).lean();
  if (!service) throw new BookingError(404, 'Servicio no encontrado', 'NOT_FOUND');
  if (online && service.onlineBooking?.enabled === false) throw new BookingError(404, 'Servicio no encontrado', 'NOT_FOUND');
  if (service.bookingMode === 'quote') return { service, slots: [] };

  const { contextFor } = await loadEngineData(businessId, [service], from, to);
  const ctx = contextFor(service, { online });
  const preferred = {};
  if (resourceId) {
    const idx = (service.requirements || []).findIndex((r) => r.kind === 'staff' && (!online || r.customerCanChoose));
    if (idx === -1) throw new BookingError(400, 'Este servicio no permite elegir profesional', 'BAD_REQUEST');
    preferred[idx] = String(resourceId);
  }
  const slots = findSlots(ctx, { from, to, partySize, preferred });
  return { service, slots };
}

function matchCustomerQuery(businessId, phone, email) {
  const or = [];
  if (email) or.push({ email });
  const candidates = getPhoneMatchCandidates(phone);
  if (candidates.length) or.push({ normalizedPhone: { $in: candidates } });
  return or.length ? { businessId, $or: or } : null;
}

async function findOrCreateCustomer(businessId, { name, phone, email }) {
  const query = matchCustomerQuery(businessId, phone, email);
  if (!query) return null;
  const existing = await Customer.findOne(query).sort({ createdAt: 1 });
  if (existing) return existing;
  return Customer.create({ businessId, name, phone, normalizedPhone: toStoredNormalizedPhone(phone), email });
}

async function occupy(businessId, bookingId, segments) {
  const docs = [];
  for (const seg of segments) {
    for (const rid of seg.resourceIds) {
      for (const cell of cellsFor(seg.busyStart, seg.busyEnd)) {
        docs.push({ businessId, resourceId: rid, cell, bookingId });
      }
    }
  }
  if (!docs.length) return;
  try {
    await Occupancy.insertMany(docs, { ordered: true });
  } catch (err) {
    await Occupancy.deleteMany({ bookingId });
    if (err?.code === 11000 || err?.writeErrors?.some?.((e) => e.code === 11000)) {
      throw new BookingError(409, 'Ese horario se acaba de ocupar. Elige otro, por favor.', 'SLOT_TAKEN');
    }
    throw err;
  }
}

/**
 * Plans the consecutive segments of a booking at date/startMin with the engine
 * data already loaded. Pure apart from the context: throws BookingError when
 * something doesn't fit.
 */
function planSegments(contextFor, { ordered, items, date, startMin, partySize, online, now }) {
  const segments = [];
  const extraBusy = [];
  let cursor = startMin;
  for (let i = 0; i < ordered.length; i++) {
    const service = ordered[i];
    const ctx = contextFor(service, { online, ...(now ? { now } : {}) });
    const preferred = {};
    if (items[i].resourceId) {
      const idx = (service.requirements || []).findIndex((r) => r.kind === 'staff' && (!online || r.customerCanChoose));
      if (idx === -1) throw new BookingError(400, 'Este servicio no permite elegir profesional', 'BAD_REQUEST');
      preferred[idx] = String(items[i].resourceId);
    }
    // "Any professional" on a later service: keep the same person as the
    // previous one when they can do it, otherwise anyone free.
    const staffIdx = (service.requirements || []).findIndex((q) => q.kind === 'staff');
    const previousStaff = segments.length ? segments[segments.length - 1].staffId : null;
    let r = null;
    if (!items[i].resourceId && staffIdx !== -1 && previousStaff) {
      r = evaluateStart(ctx, date, cursor, { partySize, preferred: { ...preferred, [staffIdx]: previousStaff }, extraBusy });
      if (!r.ok) r = null;
    }
    if (!r) r = evaluateStart(ctx, date, cursor, { partySize, preferred, extraBusy });
    if (!r.ok) {
      throw new BookingError(409, REASON_MESSAGES[r.reason] || 'No hay disponibilidad', 'NOT_AVAILABLE', { reason: r.reason, segment: i });
    }
    const resourceIds = r.assignments.flat();
    segments.push({
      serviceId: service._id,
      serviceName: service.name,
      start: r.start, end: r.end, busyStart: r.busyStart, busyEnd: r.busyEnd,
      resourceIds,
      anyStaff: !items[i].resourceId,
      staffId: staffIdx !== -1 ? (r.assignments[staffIdx] || [])[0] || null : null,
      price: (service.price?.amount || 0) * (service.price?.perPerson ? partySize : 1),
    });
    for (const rid of resourceIds) extraBusy.push({ resourceId: rid, start: r.busyStart, end: r.busyEnd });
    cursor += service.durationMin;
  }
  return segments;
}

async function loadOrderedServices(businessId, items, { activeOnly = true } = {}) {
  const ids = items.map((i) => i.serviceId);
  const services = await Service.find({ _id: { $in: ids }, businessId, ...(activeOnly ? { active: true } : {}) }).lean();
  const byId = new Map(services.map((s) => [String(s._id), s]));
  const ordered = ids.map((id) => byId.get(String(id)));
  if (ordered.some((s) => !s)) throw new BookingError(404, 'Servicio no encontrado', 'NOT_FOUND');
  return ordered;
}

/**
 * Creates a booking of one or more consecutive services starting at date/time.
 * items: [{ serviceId, resourceId? }] — resourceId = chosen professional.
 */
async function createBooking({
  businessId, date, time, items, partySize = 1, guest, notes = '', internalNotes = '',
  online, source, userId = null,
}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 5) {
    throw new BookingError(400, 'Indica entre 1 y 5 servicios', 'BAD_REQUEST');
  }
  const startMin = toMinutes(time);
  if (!isAligned(startMin)) throw new BookingError(400, 'La hora debe ser múltiplo de 5 minutos', 'BAD_REQUEST');
  const ordered = await loadOrderedServices(businessId, items);

  return withLock(`bookings:${businessId}:${date}`, async () => {
    const { contextFor } = await loadEngineData(businessId, ordered, date, addDaysToDate(date, 1));
    const segments = planSegments(contextFor, { ordered, items, date, startMin, partySize, online });

    const needsApproval = online && ordered.some((s) => s.onlineBooking?.requireApproval);
    const customer = await findOrCreateCustomer(businessId, guest);
    const booking = new Booking({
      businessId,
      customerId: customer?._id || null,
      guestName: guest.name,
      guestPhone: guest.phone || '',
      guestEmail: guest.email || '',
      status: needsApproval ? 'pending' : 'confirmed',
      start: segments[0].start,
      end: segments[segments.length - 1].end,
      partySize,
      segments,
      source,
      notes,
      internalNotes,
      totalPrice: segments.reduce((sum, s) => sum + s.price, 0),
      createdBy: userId,
    });
    await booking.validate();
    await occupy(booking.businessId, booking._id, booking.segments);
    try {
      await booking.save();
    } catch (err) {
      await Occupancy.deleteMany({ bookingId: booking._id });
      throw err;
    }
    return booking;
  });
}

// ── Change the day, time, services or professional of an appointment ────────
const MOVABLE = ['pending', 'confirmed', 'checked_in'];

/** The services and chosen professionals of a booking, as createBooking items. */
async function itemsOf(booking) {
  const ids = [...new Set(booking.segments.flatMap((s) => (s.resourceIds || []).map(String)))];
  const staff = new Set((await Resource.find({ _id: { $in: ids }, kind: 'staff' }).select('_id').lean()).map((r) => String(r._id)));
  return booking.segments.map((s) => ({
    serviceId: s.serviceId,
    resourceId: s.anyStaff ? null : ((s.resourceIds || []).map(String).find((id) => staff.has(id)) || null),
  }));
}

function assertMovable(booking, { online }) {
  const allowed = online ? ['pending', 'confirmed'] : MOVABLE;
  if (booking.payment) throw new BookingError(400, 'Esta cita ya está cobrada. Deshaz el cobro para cambiarla.', 'ALREADY_PAID');
  if (!allowed.includes(booking.status)) throw new BookingError(400, 'Esta cita ya no se puede cambiar', 'BAD_TRANSITION');
}

/**
 * Free start times for `booking` (with its own services/professionals, or
 * `items`) between two dates, ignoring the booking itself.
 */
async function rescheduleSlots(booking, { from, to, items = null, online }) {
  assertMovable(booking, { online });
  const list = items || await itemsOf(booking);
  const ordered = await loadOrderedServices(booking.businessId, list, { activeOnly: online });
  const { contextFor } = await loadEngineData(booking.businessId, ordered, from, to, { excludeBookingId: booking._id });
  const first = ordered[0];
  const ctx = contextFor(first, { online });
  const preferred = {};
  if (list[0].resourceId) {
    const idx = (first.requirements || []).findIndex((r) => r.kind === 'staff');
    if (idx !== -1) preferred[idx] = String(list[0].resourceId);
  }
  const partySize = booking.partySize || 1;
  const candidates = findSlots(ctx, { from, to, partySize, preferred, maxDays: 31 });
  const out = [];
  for (const c of candidates) {
    if (ordered.length > 1) {
      try {
        planSegments(contextFor, { ordered, items: list, date: c.date, startMin: toMinutes(c.time), partySize, online });
      } catch { continue; }
    }
    out.push({ date: c.date, time: c.time, start: c.start, end: c.end });
  }
  return out;
}

/**
 * Moves an appointment: new date/time and, optionally, new services or
 * professionals (`items`). The old slot is only released once the new one is
 * held, so a failed move leaves the appointment exactly as it was.
 */
async function rescheduleBooking(booking, { date, time, items = null, online, notBefore = null }) {
  assertMovable(booking, { online });
  const startMin = toMinutes(time);
  if (!isAligned(startMin)) throw new BookingError(400, 'La hora debe ser múltiplo de 5 minutos', 'BAD_REQUEST');
  const list = items || await itemsOf(booking);
  if (!Array.isArray(list) || !list.length || list.length > 5) throw new BookingError(400, 'Indica entre 1 y 5 servicios', 'BAD_REQUEST');
  const ordered = await loadOrderedServices(booking.businessId, list, { activeOnly: online });
  const partySize = booking.partySize || 1;

  return withLock(`bookings:${booking.businessId}:${date}`, async () => {
    const { contextFor } = await loadEngineData(booking.businessId, ordered, date, addDaysToDate(date, 1), { excludeBookingId: booking._id });
    const segments = planSegments(contextFor, { ordered, items: list, date, startMin, partySize, online });
    if (notBefore && segments[0].start.getTime() < notBefore.getTime()) {
      throw new BookingError(400, 'Esa hora está demasiado cerca. Elige otra con más antelación.', 'TOO_LATE');
    }

    const before = {
      segments: booking.segments.map((s) => (s.toObject ? s.toObject() : s)),
      start: booking.start, end: booking.end, totalPrice: booking.totalPrice,
    };
    // Free the old cells, take the new ones; put the old ones back if that fails.
    await Occupancy.deleteMany({ bookingId: booking._id });
    try {
      await occupy(booking.businessId, booking._id, segments);
    } catch (err) {
      await occupy(booking.businessId, booking._id, before.segments).catch(() => {});
      throw err;
    }
    const servicesChanged = before.segments.map((s) => String(s.serviceId)).join() !== segments.map((s) => String(s.serviceId)).join();
    booking.segments = segments;
    booking.start = segments[0].start;
    booking.end = segments[segments.length - 1].end;
    // Keep an agreed price when only the time changes.
    if (servicesChanged) booking.totalPrice = segments.reduce((sum, s) => sum + s.price, 0);
    if (before.start.getTime() !== booking.start.getTime()) {
      booking.reminderSentAt = null;
      booking.rescheduledAt = new Date();
      booking.rescheduleCount = (booking.rescheduleCount || 0) + 1;
      booking.previousStart = before.start;
    }
    try {
      await booking.save();
    } catch (err) {
      await Occupancy.deleteMany({ bookingId: booking._id });
      await occupy(booking.businessId, booking._id, before.segments).catch(() => {});
      throw err;
    }
    return { booking, previousStart: before.start };
  });
}

async function withLock(key, fn) {
  const release = await acquireLock(key);
  try { return await fn(); } finally { release(); }
}

async function cancelBooking(booking) {
  if (booking.status === 'cancelled') return booking;
  booking.status = 'cancelled';
  booking.cancelledAt = new Date();
  await booking.save();
  await Occupancy.deleteMany({ bookingId: booking._id });
  return booking;
}

const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'completed', 'cancelled', 'no_show'],
  checked_in: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: ['confirmed'],
};

async function changeStatus(booking, status) {
  if (!TRANSITIONS[booking.status]?.includes(status)) {
    throw new BookingError(400, `No se puede pasar de ${booking.status} a ${status}`, 'BAD_TRANSITION');
  }
  if (status === 'cancelled') return cancelBooking(booking);
  if (booking.status === 'no_show' && status === 'confirmed') {
    // re-occupy: the slot may have been taken meanwhile
    await occupy(booking.businessId, booking._id, booking.segments);
  }
  booking.status = status;
  await booking.save();
  if (status === 'no_show') await Occupancy.deleteMany({ bookingId: booking._id });
  return booking;
}

// ── Move an appointment to another professional ─────────────────────────────
const REASSIGNABLE = ['pending', 'confirmed', 'checked_in'];

function localMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

/**
 * Checks whether `toId` can take over the parts of `booking` done by `fromId`
 * (does that service, works then, is free and not absent). Returns the new
 * resourceIds per segment, or null.
 */
async function planReassign(booking, fromId, toId, engine) {
  const from = String(fromId);
  const newSegments = [];
  let touched = 0;
  for (const seg of booking.segments) {
    const ids = (seg.resourceIds || []).map(String);
    if (!ids.includes(from)) { newSegments.push(ids); continue; }
    touched++;
    if (ids.includes(String(toId))) return null;
    const service = engine.services.find((x) => String(x._id) === String(seg.serviceId));
    const idx = (service?.requirements || []).findIndex((r) => r.kind === 'staff');
    if (!service || idx === -1) return null;
    const ctx = engine.contextFor(service, { online: false });
    const r = evaluateStart(ctx, engine.date, localMinutes(new Date(seg.start), engine.timezone), {
      partySize: booking.partySize || 1, preferred: { [idx]: String(toId) },
    });
    if (!r.ok) return null;
    newSegments.push(ids.map((id) => (id === from ? String(toId) : id)));
  }
  return touched ? newSegments : null;
}

async function reassignEngine(booking) {
  const business = await Business.findById(booking.businessId).select('timezone').lean();
  const timezone = businessTimezone(business);
  const date = dateInTimezone(new Date(booking.start), timezone);
  const services = await Service.find({ _id: { $in: booking.segments.map((s) => s.serviceId) }, businessId: booking.businessId }).lean();
  const engine = await loadEngineData(booking.businessId, services, date, date, { excludeBookingId: booking._id });
  return { ...engine, services, date, timezone };
}

function assertReassignable(booking, fromId) {
  if (!REASSIGNABLE.includes(booking.status)) throw new BookingError(400, 'Esta cita ya no se puede cambiar de profesional', 'BAD_REQUEST');
  if (!booking.segments.some((s) => (s.resourceIds || []).map(String).includes(String(fromId)))) {
    throw new BookingError(400, 'Ese profesional no está en esta cita', 'BAD_REQUEST');
  }
}

/** Professionals who could take the appointment instead of `fromId`. */
async function reassignOptions(booking, fromId) {
  assertReassignable(booking, fromId);
  const engine = await reassignEngine(booking);
  const staff = await Resource.find({ businessId: booking.businessId, kind: 'staff', active: true, _id: { $ne: fromId } })
    .sort({ sortOrder: 1, name: 1 }).lean();
  const out = [];
  for (const r of staff) if (await planReassign(booking, fromId, r._id, engine)) out.push({ _id: r._id, name: r.name });
  return out;
}

async function reassignBooking(booking, fromId, toId) {
  assertReassignable(booking, fromId);
  const engine = await reassignEngine(booking);
  return withLock(`bookings:${booking.businessId}:${engine.date}`, async () => {
    const plan = await planReassign(booking, fromId, toId, engine);
    if (!plan) throw new BookingError(409, 'Esa persona no está libre o no hace este servicio a esa hora', 'NOT_AVAILABLE');
    const before = booking.segments.map((s) => s.resourceIds);
    booking.segments.forEach((s, i) => { s.resourceIds = plan[i]; s.anyStaff = false; });
    await Occupancy.deleteMany({ bookingId: booking._id });
    try {
      await occupy(booking.businessId, booking._id, booking.segments);
    } catch (err) {
      booking.segments.forEach((s, i) => { s.resourceIds = before[i]; });
      await occupy(booking.businessId, booking._id, booking.segments).catch(() => {});
      throw err;
    }
    await booking.save();
    return booking;
  });
}

function todayFor(timezone) {
  return dateInTimezone(new Date(), timezone);
}

module.exports = {
  BookingError, getAvailability, createBooking, cancelBooking, rescheduleBooking, rescheduleSlots, planSegments, changeStatus, todayFor, reassignOptions, reassignBooking,
  isValidObjectId: (id) => mongoose.isValidObjectId(id),
};
