/**
 * HTTP handlers for the generic agenda. Private handlers run behind
 * requireAuth + requireModule('bookings'); public ones check that the
 * business exists and has the module enabled.
 */
const Business = require('../../../core/models/Business');
const BusinessMember = require('../../../core/models/BusinessMember');
const { canUseModule } = require('../../../core/lib/planCapabilities');
const { businessTimezone } = require('../../../core/lib/timezone');
const Resource = require('../models/Resource');
const Schedule = require('../models/Schedule');
const Service = require('../models/Service');
const Booking = require('../models/Booking');
const svc = require('../services/bookingsService');
const v = require('../lib/validation');
const { BookingError } = require('../lib/errors');
const emails = require('../services/bookingEmails');
const { getDashboardStats } = require('../services/statsService');
const { summarizeCustomer } = require('../lib/customers');
const { buildPayment, tillTotals } = require('../lib/checkout');
const team = require('../services/teamService');
const CashClose = require('../models/CashClose');
const { dateInTimezone } = require('../../../core/lib/timezone');
const { businessLogoUrl } = require('../../../core/lib/images');
const absences = require('../services/absencesService');
const followUps = require('../services/followUpsService');
const policy = require('../services/policyService');
const limits = require('../lib/planLimits');

// Emails never block or fail the request; errors are logged inside.
const later = (fn) => { Promise.resolve().then(fn).catch(() => {}); };

function handle(fn) {
  return async function bookingsHandler(req, res) {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BookingError) {
        return res.status(err.status).json({
          message: err.message, code: err.code, ...(err.reason ? { reason: err.reason } : {}), ...(err.bookings ? { bookings: err.bookings } : {}),
          ...(err.upgradeRequired ? { upgradeRequired: true, feature: err.feature } : {}),
        });
      }
      if (err?.name === 'ValidationError' || err?.name === 'CastError') {
        return res.status(400).json({ message: 'Datos no válidos', code: 'BAD_REQUEST' });
      }
      console.error('[bookings]', err);
      return res.status(500).json({ message: 'Error interno del servidor' });
    }
  };
}

const notFound = (what) => new BookingError(404, `${what} no encontrado`, 'NOT_FOUND');

async function assertResourcesBelong(businessId, ids) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return;
  const count = await Resource.countDocuments({ businessId, _id: { $in: unique } });
  if (count !== unique.length) throw new BookingError(400, 'Algún recurso no pertenece al negocio', 'BAD_REQUEST');
}

// ── Resources ───────────────────────────────────────────────────────────────
exports.listResources = handle(async (req, res) => {
  const filter = { businessId: req.businessId };
  if (req.query.includeInactive !== 'true') filter.active = true;
  res.json(await Resource.find(filter).sort({ kind: 1, sortOrder: 1, name: 1 }).lean());
});

exports.createResource = handle(async (req, res) => {
  const data = v.resourceInput(req.body || {});
  if (data.parentId) await assertResourcesBelong(req.businessId, [data.parentId]);
  if (data.kind === 'staff' && data.active !== false) await limits.assertCanAddProfessional(req.businessId, Resource);
  res.status(201).json(await Resource.create({ ...data, businessId: req.businessId }));
});

exports.updateResource = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const data = v.resourceInput(req.body || {}, { partial: true });
  if (data.parentId) await assertResourcesBelong(req.businessId, [data.parentId]);
  if (data.active === true) {
    const current = await Resource.findOne({ _id: req.params.id, businessId: req.businessId }).select('kind active').lean();
    if (current?.kind === 'staff' && !current.active) await limits.assertCanAddProfessional(req.businessId, Resource, { excludeId: req.params.id });
  }
  if (data.userId) {
    const member = await BusinessMember.exists({ businessId: req.businessId, userId: data.userId, status: { $ne: 'invited' } });
    if (!member) throw new BookingError(400, 'Ese usuario no es del equipo de este negocio', 'BAD_REQUEST');
    // A person is one professional: unlink them from any other
    await Resource.updateMany({ businessId: req.businessId, userId: data.userId, _id: { $ne: req.params.id } }, { $set: { userId: null } });
  }
  const doc = await Resource.findOneAndUpdate({ _id: req.params.id, businessId: req.businessId }, data, { new: true, runValidators: true });
  if (!doc) throw notFound('Recurso');
  if (doc.minCapacity > doc.capacity) throw new BookingError(400, 'La capacidad mínima supera la capacidad', 'BAD_REQUEST');
  res.json(doc);
});

/**
 * Which services a staff member does, edited from the staff member's side.
 * A service's staff requirement with no resourceIds means "anyone"; we keep it
 * that way while everybody can do it, and list names only when someone can't.
 */
exports.setResourceServices = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const wanted = new Set((Array.isArray(req.body?.serviceIds) ? req.body.serviceIds : []).map((id) => String(v.objectId(id, 'serviceIds'))));
  const resource = await Resource.findOne({ _id: req.params.id, businessId: req.businessId, active: true, kind: 'staff' }).lean();
  if (!resource) throw notFound('Profesional');
  const [allStaff, services] = await Promise.all([
    Resource.find({ businessId: req.businessId, active: true, kind: 'staff' }).select('_id').lean(),
    Service.find({ businessId: req.businessId, active: true }),
  ]);
  const staffIds = allStaff.map((r) => String(r._id));
  const me = String(resource._id);
  const updates = [];
  for (const service of services) {
    const reqIdx = (service.requirements || []).findIndex((r) => r.kind === 'staff');
    const shouldDo = wanted.has(String(service._id));
    if (reqIdx === -1) {
      if (!shouldDo) continue;
      service.requirements.push({ kind: 'staff', resourceIds: [me], customerCanChoose: true });
      updates.push(service);
      continue;
    }
    const requirement = service.requirements[reqIdx];
    const current = (requirement.resourceIds || []).map(String);
    const allowed = current.length ? current.filter((id) => staffIds.includes(id)) : [...staffIds];
    const does = allowed.includes(me);
    if (does === shouldDo) continue;
    let next = shouldDo ? [...allowed, me] : allowed.filter((id) => id !== me);
    if (!next.length) throw new BookingError(400, `Nadie más hace "${service.name}". Asígnaselo antes a otra persona.`, 'BAD_REQUEST');
    if (staffIds.every((id) => next.includes(id))) next = [];
    requirement.resourceIds = next;
    updates.push(service);
  }
  await Promise.all(updates.map((doc) => doc.save()));
  res.json({ ok: true, updated: updates.length });
});

// Soft delete: past bookings keep pointing to it.
exports.deleteResource = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const doc = await Resource.findOneAndUpdate({ _id: req.params.id, businessId: req.businessId }, { active: false }, { new: true });
  if (!doc) throw notFound('Recurso');
  res.json({ ok: true });
});

// ── Dashboard ───────────────────────────────────────────────────────────────
exports.getStats = handle(async (req, res) => {
  res.json(await getDashboardStats(req.businessId));
});

// ── Customers (appointment history) ─────────────────────────────────────────
const CUSTOMER_FIELDS = 'customerId status start end segments totalPrice source notes internalNotes guestName';

// Visits, last/next appointment, spend and "due back" for every customer.
exports.customersSummary = handle(async (req, res) => {
  const since = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
  const bookings = await Booking.find({ businessId: req.businessId, customerId: { $ne: null }, start: { $gte: since } })
    .select(CUSTOMER_FIELDS).lean();
  const byCustomer = new Map();
  for (const b of bookings) {
    const k = String(b.customerId);
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(b);
  }
  const now = new Date();
  const out = {};
  for (const [id, list] of byCustomer) out[id] = summarizeCustomer(list, now);
  res.json(out);
});

// One customer's appointments (newest first) and summary.
exports.customerBookings = handle(async (req, res) => {
  const customerId = v.objectId(req.params.customerId, 'customerId');
  const bookings = await Booking.find({ businessId: req.businessId, customerId })
    .select(CUSTOMER_FIELDS).sort({ start: -1 }).limit(500).lean();
  res.json({ summary: summarizeCustomer(bookings), bookings });
});

// ── Services ────────────────────────────────────────────────────────────────
exports.listServices = handle(async (req, res) => {
  const filter = { businessId: req.businessId };
  if (req.query.includeInactive !== 'true') filter.active = true;
  res.json(await Service.find(filter).sort({ sortOrder: 1, name: 1 }).lean());
});

exports.createService = handle(async (req, res) => {
  const data = v.serviceInput(req.body || {});
  v.checkServiceConsistency(data);
  await assertResourcesBelong(req.businessId, (data.requirements || []).flatMap((r) => r.resourceIds));
  res.status(201).json(await Service.create({ ...data, businessId: req.businessId }));
});

exports.updateService = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const doc = await Service.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!doc) throw notFound('Servicio');
  const data = v.serviceInput(req.body || {}, { partial: true });
  doc.set(data);
  v.checkServiceConsistency(doc.toObject());
  await assertResourcesBelong(req.businessId, (doc.requirements || []).flatMap((r) => r.resourceIds));
  await doc.save();
  res.json(doc);
});

exports.deleteService = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const doc = await Service.findOneAndUpdate({ _id: req.params.id, businessId: req.businessId }, { active: false }, { new: true });
  if (!doc) throw notFound('Servicio');
  res.json({ ok: true });
});

// ── Schedules ───────────────────────────────────────────────────────────────
function scheduleOwner(req) {
  const ownerType = req.query.ownerType || req.body?.ownerType || 'business';
  if (ownerType === 'business') return { ownerType, ownerId: req.businessId };
  if (ownerType !== 'resource') throw new BookingError(400, 'ownerType no es válido', 'BAD_REQUEST');
  return { ownerType, ownerId: v.objectId(req.query.ownerId || req.body?.ownerId, 'ownerId') };
}

exports.getSchedule = handle(async (req, res) => {
  const owner = scheduleOwner(req);
  const doc = await Schedule.findOne({ businessId: req.businessId, ...owner }).lean();
  res.json(doc || { ...owner, rules: [], overrides: [] });
});

exports.putSchedule = handle(async (req, res) => {
  const owner = scheduleOwner(req);
  if (owner.ownerType === 'resource') await assertResourcesBelong(req.businessId, [owner.ownerId]);
  const data = v.scheduleInput(req.body || {});
  const doc = await Schedule.findOneAndUpdate(
    { businessId: req.businessId, ...owner },
    { $set: data, $setOnInsert: { businessId: req.businessId, ...owner } },
    { new: true, upsert: true, runValidators: true },
  );
  res.json(doc);
});

// Remove a resource's own schedule so it follows business hours again.
exports.deleteSchedule = handle(async (req, res) => {
  const owner = scheduleOwner(req);
  if (owner.ownerType !== 'resource') throw new BookingError(400, 'Solo se puede borrar el horario de un recurso', 'BAD_REQUEST');
  await Schedule.deleteOne({ businessId: req.businessId, ...owner });
  res.json({ ok: true });
});

// ── Availability & bookings (staff side) ────────────────────────────────────
function slotView(s) {
  return { date: s.date, time: s.time, start: s.start, end: s.end, resourceIds: s.resourceIds };
}

exports.getAvailability = handle(async (req, res) => {
  const { from, to } = v.dateRange(req.query, { maxDays: 62 });
  const { slots } = await svc.getAvailability({
    businessId: req.businessId,
    serviceId: v.objectId(req.query.serviceId, 'serviceId'),
    from, to,
    partySize: req.query.partySize ? Number(req.query.partySize) : 1,
    resourceId: req.query.resourceId ? v.objectId(req.query.resourceId, 'resourceId') : null,
    online: false,
  });
  res.json(slots.map(slotView));
});

exports.listBookings = handle(async (req, res) => {
  const { from, to } = v.dateRange(req.query, { maxDays: 62 });
  const business = await Business.findById(req.businessId).select('timezone').lean();
  const tz = businessTimezone(business);
  const { localToUtc } = require('../lib/availability');
  const filter = {
    businessId: req.businessId,
    start: { $lt: localToUtc(to, 1440, tz) },
    end: { $gt: localToUtc(from, 0, tz) },
  };
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.resourceId) filter['segments.resourceIds'] = v.objectId(req.query.resourceId, 'resourceId');
  res.json(await Booking.find(filter).sort({ start: 1 }).select('-publicToken').lean());
});

exports.getBooking = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const doc = await Booking.findOne({ _id: req.params.id, businessId: req.businessId }).select('-publicToken').lean();
  if (!doc) throw notFound('Cita');
  res.json(doc);
});

exports.createBooking = handle(async (req, res) => {
  const input = v.bookingInput(req.body || {}, { online: false });
  const source = ['phone', 'walk_in', 'staff'].includes(req.body?.source) ? req.body.source : 'staff';
  await limits.assertBookingQuota(req.businessId, Booking, { online: false });
  const booking = await svc.createBooking({
    businessId: req.businessId, ...input, online: false, source, userId: req.user?.id || null,
  });
  // Booked by phone/at the desk: the customer still gets the confirmation if we have their email.
  later(() => emails.sendBookingConfirmation(booking));
  const out = booking.toObject();
  delete out.publicToken;
  res.status(201).json(out);
});

exports.setBookingStatus = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!booking) throw notFound('Cita');
  const previous = booking.status;
  await svc.changeStatus(booking, String(req.body?.status || ''));
  if (previous === 'pending' && booking.status === 'confirmed') later(() => emails.sendBookingConfirmation(booking));
  if (booking.status === 'cancelled' && previous !== 'cancelled') later(() => emails.sendBookingCancelled(booking));
  const out = booking.toObject();
  delete out.publicToken;
  res.json(out);
});

exports.updateBookingNotes = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const update = {};
  if (req.body?.notes !== undefined) update.notes = String(req.body.notes).slice(0, 1000);
  if (req.body?.internalNotes !== undefined) update.internalNotes = String(req.body.internalNotes).slice(0, 2000);
  const r = await Booking.updateOne({ _id: req.params.id, businessId: req.businessId }, update);
  if (!r.matchedCount) throw notFound('Cita');
  res.json(await Booking.findById(req.params.id).select('-publicToken').lean());
});

// ── Team (pay, commissions, what each professional leaves) ─────────────────
exports.teamReport = handle(async (req, res) => {
  const { from, to } = v.dateRange(req.query, { maxDays: 366 });
  res.json(await team.teamReport(req.businessId, from, to));
});

exports.setTeamPay = handle(async (req, res) => {
  v.objectId(req.params.resourceId, 'resourceId');
  const tz = await businessTz(req.businessId);
  res.json(await team.setPay(req.businessId, req.params.resourceId, req.body || {}, dateInTimezone(new Date(), tz)));
});

exports.addTeamPayment = handle(async (req, res) => {
  v.objectId(req.params.resourceId, 'resourceId');
  res.status(201).json(await team.addPayment(req.businessId, req.params.resourceId, req.body || {}));
});

// ── Caja: charge appointments and close the day ─────────────────────────────
async function businessTz(businessId) {
  return businessTimezone(await Business.findById(businessId).select('timezone').lean());
}

async function assertTillOpen(businessId, date) {
  if (await CashClose.exists({ businessId, date })) {
    throw new BookingError(409, 'La caja de ese día ya está cerrada. Reábrela para cambiar cobros.', 'TILL_CLOSED');
  }
}

exports.checkout = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId }).select('-publicToken').lean();
  if (!booking) throw notFound('Cita');
  const tz = await businessTz(req.businessId);
  const now = new Date();
  const localDate = dateInTimezone(now, tz);
  await assertTillOpen(req.businessId, localDate);
  const payment = buildPayment(booking, req.body || {}, { now, localDate, userId: req.user?.id || null });
  const doc = await Booking.findOneAndUpdate(
    { _id: booking._id, businessId: req.businessId, payment: null, status: { $in: ['confirmed', 'checked_in', 'completed'] } },
    { $set: { payment, status: 'completed' } },
    { new: true },
  ).lean();
  if (!doc) throw new BookingError(409, 'Esta cita ya está cobrada', 'ALREADY_PAID');
  delete doc.publicToken;
  res.json(doc);
});

exports.undoCheckout = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId }).select('payment').lean();
  if (!booking) throw notFound('Cita');
  if (!booking.payment) throw new BookingError(400, 'Esta cita no está cobrada', 'BAD_REQUEST');
  await assertTillOpen(req.businessId, booking.payment.date);
  const doc = await Booking.findOneAndUpdate({ _id: booking._id }, { $set: { payment: null } }, { new: true }).lean();
  delete doc.publicToken;
  res.json(doc);
});

// The till of a day: what was charged (by method), what is left to charge
// and whether the day is closed.
exports.cashDay = handle(async (req, res) => {
  const tz = await businessTz(req.businessId);
  const date = req.query.date ? v.dateRange({ from: req.query.date }, { maxDays: 1 }).from : dateInTimezone(new Date(), tz);
  const { localToUtc } = require('../lib/availability');
  const [paid, ofDay, close] = await Promise.all([
    Booking.find({ businessId: req.businessId, 'payment.date': date })
      .select('guestName customerId start segments totalPrice status payment').sort({ 'payment.paidAt': -1 }).lean(),
    Booking.find({
      businessId: req.businessId,
      start: { $gte: localToUtc(date, 0, tz), $lt: localToUtc(date, 1440, tz) },
      status: { $in: ['confirmed', 'checked_in', 'completed'] },
      payment: null,
    }).select('guestName customerId start end segments totalPrice status').sort({ start: 1 }).lean(),
    CashClose.findOne({ businessId: req.businessId, date }).lean(),
  ]);
  res.json({
    date,
    totals: tillTotals(paid.map((b) => b.payment)),
    payments: paid,
    toCharge: ofDay,
    toChargeAmount: ofDay.reduce((s, b) => s + (b.totalPrice || 0), 0),
    close,
  });
});

exports.closeCash = handle(async (req, res) => {
  const tz = await businessTz(req.businessId);
  const date = req.body?.date ? v.dateRange({ from: req.body.date }, { maxDays: 1 }).from : dateInTimezone(new Date(), tz);
  const paid = await Booking.find({ businessId: req.businessId, 'payment.date': date }).select('payment').lean();
  const totals = tillTotals(paid.map((b) => b.payment));
  let countedCash = null;
  if (req.body?.countedCash !== undefined && req.body.countedCash !== null && req.body.countedCash !== '') {
    countedCash = Number(req.body.countedCash);
    if (!Number.isInteger(countedCash) || countedCash < 0 || countedCash > 100_000_00) throw new BookingError(400, 'El efectivo contado no es válido', 'BAD_REQUEST');
  }
  try {
    const doc = await CashClose.create({
      businessId: req.businessId, date, totals, countedCash,
      difference: countedCash === null ? null : countedCash - totals.cash,
      note: String(req.body?.note || '').slice(0, 500),
      closedBy: req.user?.id || null,
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err?.code === 11000) throw new BookingError(409, 'La caja de ese día ya está cerrada', 'TILL_CLOSED');
    throw err;
  }
});

exports.reopenCash = handle(async (req, res) => {
  const date = v.dateRange({ from: req.query.date }, { maxDays: 1 }).from;
  const r = await CashClose.deleteOne({ businessId: req.businessId, date });
  if (!r.deletedCount) throw notFound('Cierre de caja');
  res.json({ ok: true });
});

// ── Public (guest) side ─────────────────────────────────────────────────────
async function publicBusiness(businessId) {
  v.objectId(businessId, 'businessId');
  const business = await Business.findById(businessId)
    .select('name phone email address brandColor logoUpdatedAt timezone plan subscriptionStatus moduleOverrides businessType').lean();
  if (!business || !canUseModule(business, 'bookings')) throw notFound('Negocio');
  return business;
}

exports.publicCatalog = handle(async (req, res) => {
  const business = await publicBusiness(req.params.businessId);
  const services = await Service.find({ businessId: business._id, active: true, 'onlineBooking.enabled': { $ne: false } })
    .sort({ sortOrder: 1, name: 1 }).lean();
  const choosableIds = new Set();
  const anyStaffKinds = services.some((s) => (s.requirements || []).some((r) => r.customerCanChoose && !(r.resourceIds || []).length));
  services.forEach((s) => (s.requirements || []).forEach((r) => r.customerCanChoose && (r.resourceIds || []).forEach((id) => choosableIds.add(String(id)))));
  const staff = await Resource.find({
    businessId: business._id, active: true, bookableOnline: { $ne: false }, kind: 'staff',
    ...(anyStaffKinds ? {} : { _id: { $in: [...choosableIds] } }),
  }).select('name kind color photo').sort({ sortOrder: 1, name: 1 }).lean();
  const [rules, caps, activeStaff] = await Promise.all([
    policy.getPolicy(business._id),
    limits.capsFor(business._id),
    Resource.find({ businessId: business._id, kind: 'staff', active: true }).select('kind active sortOrder createdAt').lean(),
  ]);
  const locked = limits.lockedStaff(activeStaff, caps);
  res.json({
    business: { id: business._id, name: business.name, phone: business.phone, address: business.address, brandColor: business.brandColor, logoUrl: businessLogoUrl(business), timezone: businessTimezone(business) },
    policy: { changeMinHours: rules.changeMinHours, allowReschedule: rules.allowReschedule, note: rules.note },
    services: services.map((s) => ({
      id: s._id, name: s.name, category: s.category, description: s.description, durationMin: s.durationMin,
      bookingMode: s.bookingMode, partySize: s.partySize, price: s.price,
      staffChoice: (s.requirements || []).some((r) => r.kind === 'staff' && r.customerCanChoose)
        ? (s.requirements.find((r) => r.kind === 'staff' && r.customerCanChoose).resourceIds || []).map(String)
        : null,
    })),
    staff: staff.filter((r) => !locked.has(String(r._id))).map((r) => ({ id: r._id, name: r.name, color: r.color || null, photo: r.photo || null })),
  });
});

exports.publicAvailability = handle(async (req, res) => {
  const business = await publicBusiness(req.params.businessId);
  const { from, to } = v.dateRange(req.query, { maxDays: 31 });
  const { slots } = await svc.getAvailability({
    businessId: business._id,
    serviceId: v.objectId(req.query.serviceId, 'serviceId'),
    from, to,
    partySize: req.query.partySize ? Number(req.query.partySize) : 1,
    resourceId: req.query.resourceId ? v.objectId(req.query.resourceId, 'resourceId') : null,
    online: true,
  });
  // Guests see times, not which resource would be used.
  res.json(slots.map((s) => ({ date: s.date, time: s.time, start: s.start, end: s.end })));
});

function publicBookingView(b) {
  return {
    id: b._id, status: b.status, start: b.start, end: b.end, partySize: b.partySize,
    guestName: b.guestName,
    services: b.segments.map((s) => ({ name: s.serviceName, start: s.start, end: s.end })),
    totalPrice: b.totalPrice,
  };
}

exports.publicCreateBooking = handle(async (req, res) => {
  const business = await publicBusiness(req.params.businessId);
  if (req.body?.consent !== true) throw new BookingError(400, 'Debes aceptar la política de privacidad', 'BAD_REQUEST');
  const input = v.bookingInput(req.body || {}, { online: true });
  await limits.assertBookingQuota(business._id, Booking, { online: true });
  const booking = await svc.createBooking({ businessId: business._id, ...input, online: true, source: 'online' });
  later(() => emails.sendBookingConfirmation(booking));
  later(() => emails.notifyStaffNewBooking(booking));
  res.status(201).json({ ...publicBookingView(booking), token: booking.publicToken });
});

async function bookingByToken(req) {
  const id = req.body?.bookingId || req.query.bookingId;
  const token = req.body?.token || req.query.token;
  v.objectId(id, 'bookingId');
  if (typeof token !== 'string' || token.length < 20) throw notFound('Cita');
  const booking = await Booking.findOne({ _id: id, publicToken: token });
  if (!booking) throw notFound('Cita');
  return booking;
}

async function manageView(booking) {
  const [rules, business] = await Promise.all([
    policy.getPolicy(booking.businessId),
    Business.findById(booking.businessId).select('name phone slug brandColor logoUpdatedAt timezone').lean(),
  ]);
  const rights = policy.customerRights(booking, rules);
  return {
    ...publicBookingView(booking),
    business: business ? {
      id: business._id, name: business.name, phone: business.phone || '', slug: business.slug || null,
      brandColor: business.brandColor || null, logoUrl: businessLogoUrl(business), timezone: businessTimezone(business),
    } : null,
    policy: { changeMinHours: rules.changeMinHours, note: rules.note },
    ...rights,
  };
}

function tooLate(rights, action) {
  if (rights.reason === 'too_late') {
    return new BookingError(400, `Ya no se puede ${action} online: hay que avisar con más antelación. Llama al negocio, por favor.`, 'TOO_LATE');
  }
  if (rights.reason === 'past') return new BookingError(400, 'Esta cita ya ha pasado', 'BAD_TRANSITION');
  return new BookingError(400, `Esta cita ya no se puede ${action}`, 'BAD_TRANSITION');
}

exports.publicBookingDetails = handle(async (req, res) => {
  res.json(await manageView(await bookingByToken(req)));
});

exports.publicCancelBooking = handle(async (req, res) => {
  const booking = await bookingByToken(req);
  const rights = policy.customerRights(booking, await policy.getPolicy(booking.businessId));
  if (!rights.canCancel) throw tooLate(rights, 'cancelar');
  await svc.cancelBooking(booking);
  later(() => emails.notifyStaffCancelled(booking));
  res.json(await manageView(booking));
});

exports.publicRescheduleSlots = handle(async (req, res) => {
  const booking = await bookingByToken(req);
  const rights = policy.customerRights(booking, await policy.getPolicy(booking.businessId));
  if (!rights.canReschedule) throw tooLate(rights, 'cambiar');
  const { from, to } = v.dateRange(req.body || {}, { maxDays: 31 });
  const slots = await svc.rescheduleSlots(booking, { from, to, online: true });
  // A new time must also respect the policy: not inside the notice window.
  const minStart = Date.now() + (rights.deadline ? new Date(booking.start).getTime() - rights.deadline.getTime() : 0);
  res.json(slots.filter((sl) => new Date(sl.start).getTime() > minStart).map((sl) => ({ date: sl.date, time: sl.time, start: sl.start, end: sl.end })));
});

exports.publicReschedule = handle(async (req, res) => {
  const booking = await bookingByToken(req);
  const rules = await policy.getPolicy(booking.businessId);
  const rights = policy.customerRights(booking, rules);
  if (!rights.canReschedule) throw tooLate(rights, 'cambiar');
  const { date, time } = v.dateTimeInput(req.body || {});
  const notBefore = rules.changeMinHours ? new Date(Date.now() + rules.changeMinHours * 3600000) : null;
  const { previousStart } = await svc.rescheduleBooking(booking, { date, time, online: true, notBefore });
  later(() => emails.sendBookingRescheduled(booking, previousStart));
  later(() => emails.notifyStaffRescheduled(booking, previousStart));
  res.json(await manageView(booking));
});

// ── Absences (time off) ─────────────────────────────────────────────────────
exports.listAbsences = handle(async (req, res) => {
  const { from, to } = v.dateRange(req.query, { maxDays: 120 });
  res.json(await absences.listAbsences(req, { from, to }));
});

exports.createAbsence = handle(async (req, res) => {
  res.status(201).json(await absences.createAbsence(req, v.absenceInput(req.body || {})));
});

exports.deleteAbsence = handle(async (req, res) => {
  v.objectId(req.params.id, 'id');
  await absences.deleteAbsence(req, req.params.id);
  res.json({ ok: true });
});

// ── Move an appointment to another professional ─────────────────────────────
async function loadBookingDoc(req) {
  v.objectId(req.params.id, 'id');
  const booking = await Booking.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!booking) throw notFound('Cita');
  return booking;
}

exports.reassignOptions = handle(async (req, res) => {
  const booking = await loadBookingDoc(req);
  res.json(await svc.reassignOptions(booking, v.objectId(req.query.from, 'from')));
});

exports.reassignBooking = handle(async (req, res) => {
  const booking = await loadBookingDoc(req);
  const updated = await svc.reassignBooking(booking, v.objectId(req.body?.from, 'from'), v.objectId(req.body?.to, 'to'));
  const doc = updated.toObject();
  delete doc.publicToken;
  res.json(doc);
});

// ── Change day/time/services of an appointment (agenda) ─────────────────────
function itemsInput(body) {
  if (body.items === undefined || body.items === null) return null;
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > 5) v.bad('Indica entre 1 y 5 servicios');
  return items.map((it, i) => ({
    serviceId: v.objectId(it?.serviceId, `Servicio ${i + 1}`),
    resourceId: it?.resourceId ? v.objectId(it.resourceId, `Profesional ${i + 1}`) : null,
  }));
}

exports.rescheduleSlots = handle(async (req, res) => {
  const booking = await loadBookingDoc(req);
  const { from, to } = v.dateRange(req.body || {}, { maxDays: 31 });
  res.json(await svc.rescheduleSlots(booking, { from, to, items: itemsInput(req.body || {}), online: false }));
});

exports.rescheduleBooking = handle(async (req, res) => {
  const booking = await loadBookingDoc(req);
  const { date, time } = v.dateTimeInput(req.body || {});
  const { previousStart } = await svc.rescheduleBooking(booking, { date, time, items: itemsInput(req.body || {}), online: false });
  const moved = previousStart.getTime() !== booking.start.getTime();
  if (moved && req.body?.notify !== false) later(() => emails.sendBookingRescheduled(booking, previousStart));
  const doc = booking.toObject();
  delete doc.publicToken;
  res.json(doc);
});

// ── Cancellation / change policy ────────────────────────────────────────────
exports.getPolicy = handle(async (req, res) => {
  res.json(await policy.getPolicy(req.businessId));
});

exports.savePolicy = handle(async (req, res) => {
  res.json(await policy.savePolicy(req.businessId, req.body || {}));
});

// ── Follow-up emails (te toca volver, pedir opinión) ────────────────────────
exports.getFollowUps = handle(async (req, res) => {
  const caps = await limits.capsFor(req.businessId);
  res.json({ ...(await followUps.getSettings(req.businessId)), available: !!caps.followUps });
});

exports.saveFollowUps = handle(async (req, res) => {
  const turningOn = req.body?.rebook?.enabled === true || req.body?.review?.enabled === true;
  if (turningOn) await limits.assertFeature(req.businessId, 'followUps', '«Te toca volver» y las reseñas automáticas están en el plan Pro.');
  const caps = await limits.capsFor(req.businessId);
  res.json({ ...(await followUps.saveSettings(req.businessId, req.body || {})), available: !!caps.followUps });
});
