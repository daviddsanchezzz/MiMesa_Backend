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
const { createContext, evaluateStart, findSlots } = require('../lib/availability');
const { cellsFor, isAligned } = require('../lib/occupancy');
const { toMinutes, addDaysToDate } = require('../lib/schedule');
const { BookingError } = require('../lib/errors');

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

async function loadEngineData(businessId, services, fromDate, toDate) {
  const business = await Business.findById(businessId).select('timezone').lean();
  if (!business) throw new BookingError(404, 'Negocio no encontrado', 'NOT_FOUND');
  const timezone = businessTimezone(business);

  const [resources, schedules] = await Promise.all([
    Resource.find({ businessId, active: true }).lean(),
    Schedule.find({ businessId }).lean(),
  ]);
  const businessSchedule = schedules.find((s) => s.ownerType === 'business') || null;
  const resourceSchedules = {};
  for (const s of schedules) if (s.ownerType === 'resource') resourceSchedules[String(s.ownerId)] = s;

  // Bookings that may overlap the range (one day of margin for timezones/buffers).
  const rangeStart = new Date(Date.parse(`${fromDate}T00:00:00Z`) - DAY_MS);
  const rangeEnd = new Date(Date.parse(`${toDate}T00:00:00Z`) + 2 * DAY_MS);
  const bookings = await Booking.find({
    businessId,
    status: { $in: ACTIVE_STATUSES },
    start: { $lt: rangeEnd },
    end: { $gt: rangeStart },
  }).select('segments partySize').lean();

  const busy = [];
  const poolUsageByService = {};
  for (const b of bookings) {
    for (const seg of b.segments) {
      for (const rid of seg.resourceIds || []) busy.push({ resourceId: String(rid), start: seg.busyStart, end: seg.busyEnd });
      const sid = String(seg.serviceId);
      (poolUsageByService[sid] ||= []).push({ start: seg.start, end: seg.end, partySize: b.partySize || 1 });
    }
  }
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

  const ids = items.map((i) => i.serviceId);
  const services = await Service.find({ _id: { $in: ids }, businessId, active: true }).lean();
  const byId = new Map(services.map((s) => [String(s._id), s]));
  const ordered = ids.map((id) => byId.get(String(id)));
  if (ordered.some((s) => !s)) throw new BookingError(404, 'Servicio no encontrado', 'NOT_FOUND');

  return withLock(`bookings:${businessId}:${date}`, async () => {
    const { contextFor } = await loadEngineData(businessId, ordered, date, addDaysToDate(date, 1));
    const segments = [];
    const extraBusy = [];
    let cursor = startMin;
    for (let i = 0; i < ordered.length; i++) {
      const service = ordered[i];
      const ctx = contextFor(service, { online });
      const preferred = {};
      if (items[i].resourceId) {
        const idx = (service.requirements || []).findIndex((r) => r.kind === 'staff' && (!online || r.customerCanChoose));
        if (idx === -1) throw new BookingError(400, 'Este servicio no permite elegir profesional', 'BAD_REQUEST');
        preferred[idx] = String(items[i].resourceId);
      }
      const r = evaluateStart(ctx, date, cursor, { partySize, preferred, extraBusy });
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
        price: (service.price?.amount || 0) * (service.price?.perPerson ? partySize : 1),
      });
      for (const rid of resourceIds) extraBusy.push({ resourceId: rid, start: r.busyStart, end: r.busyEnd });
      cursor += service.durationMin;
    }

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

function todayFor(timezone) {
  return dateInTimezone(new Date(), timezone);
}

module.exports = {
  BookingError, getAvailability, createBooking, cancelBooking, changeStatus, todayFor,
  isValidObjectId: (id) => mongoose.isValidObjectId(id),
};
