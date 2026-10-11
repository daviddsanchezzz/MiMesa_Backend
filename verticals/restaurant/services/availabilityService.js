/**
 * Shift/slot availability for restaurant reservations: which times are open
 * on a given date, honouring shifts, date-specific exceptions and per-slot
 * capacity. Extracted out of reservationController.js so it has a single
 * callable entry point (see docs/VETRA_AI_ARCHITECTURE.md §9 risk 1).
 */
const Reservation = require('../models/Reservation');
const Shift = require('../models/Shift');
const Exception = require('../models/Exception');
const { canUseFeature } = require('../../../core/lib/planCapabilities');

const BLOCKING_EXCEPTION_TYPES = ['closed', 'full', 'call'];
const ALL_SHIFTS_KEY = '__all__';

function toMinutes(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function generateSlots(startTime, endTime) {
  const [sh, sm] = String(startTime || '00:00').split(':').map(Number);
  let [eh, em] = String(endTime || '00:00').split(':').map(Number);
  if (eh === 0 && em === 0) {
    eh = 24;
    em = 0;
  }
  const slots = [];
  // The end time is the last time a table can be booked (included); a turno ending at midnight stops before it
  const limit = eh * 60 + em >= 1440 ? 1440 : eh * 60 + em + 1;
  for (let t = sh * 60 + sm; t < limit; t += 30) {
    const h = Math.floor(t / 60) % 24;
    const m = t % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return slots;
}

async function getApplicableShiftSlotsForDate(businessId, date) {
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getDay();
  const allShifts = await Shift.find({ businessId, days: dayOfWeek }).sort({ startTime: 1 });
  const general = allShifts.filter((s) => !s.startDate && !s.endDate);
  const specific = allShifts.filter((s) => s.startDate && s.endDate && date >= s.startDate && date <= s.endDate);
  const byName = {};
  general.forEach((s) => { byName[s.name] = s; });
  specific.forEach((s) => { byName[s.name] = s; });
  const applicable = Object.values(byName);
  const slots = [];
  applicable.forEach((shift) => {
    const times = shift.subShifts.length
      ? shift.subShifts.map((ss) => ss.time)
      : generateSlots(shift.startTime, shift.endTime);
    times.forEach((t) => slots.push({ shiftName: shift.name, time: t }));
  });
  const unique = new Map();
  slots.forEach((s) => {
    const key = `${s.shiftName}__${s.time}`;
    if (!unique.has(key)) unique.set(key, s);
  });
  return [...unique.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function getApplicableSlotsForDate(businessId, date) {
  const withShift = await getApplicableShiftSlotsForDate(businessId, date);
  return [...new Set(withShift.map((s) => s.time))].sort();
}

async function getSlotLoad({ businessId, date, time, durationMinutes }) {
  const target = toMinutes(time);
  const reservations = await Reservation.find({
    businessId,
    date,
    status: { $in: ['confirmed', 'seated'] },
  }).select('time people');

  return reservations.reduce((sum, r) => {
    const start = toMinutes(r.time);
    if (durationMinutes === 0) {
      if (start === target) return sum + (r.people || 0);
      return sum;
    }
    if (start <= target && start + durationMinutes > target) {
      return sum + (r.people || 0);
    }
    return sum;
  }, 0);
}

async function evaluateReservationStatus({ business, businessId, date, time, people }) {
  const hasPendingControl = canUseFeature(business, 'pendingApprovalControl');
  const duration = business.reservationDuration || 0;

  const overLargeGroupThreshold =
    business.requireApprovalAbove !== null &&
    business.requireApprovalAbove !== undefined &&
    Number(people) > Number(business.requireApprovalAbove);

  let overSlotCapacity = false;
  if (business.maxPeoplePerSlot) {
    const used = await getSlotLoad({ businessId, date, time, durationMinutes: duration });
    overSlotCapacity = used + Number(people) > Number(business.maxPeoplePerSlot);
  }

  if (hasPendingControl && overLargeGroupThreshold) {
    return { status: 'pending', pendingReason: 'large_group' };
  }
  if (hasPendingControl && overSlotCapacity) {
    return { status: 'pending', pendingReason: 'slot_capacity' };
  }
  if (!hasPendingControl && overSlotCapacity) {
    return { status: 'rejected_capacity', pendingReason: 'none' };
  }
  return { status: 'confirmed', pendingReason: 'none' };
}

async function getExceptionBlocksForShift({ businessId, date, shiftName, roomId = null }) {
  const rows = await Exception.find({
    businessId,
    date,
    shiftName: { $in: [shiftName, ALL_SHIFTS_KEY] },
  }).select('type roomId message').lean();
  const blocking = rows.find((r) => BLOCKING_EXCEPTION_TYPES.includes(r.type));
  if (blocking) {
    return {
      blocked: true,
      type: blocking.type,
      message: blocking.message || null,
    };
  }

  if (roomId) {
    const roomBlocked = rows.find((r) => r.type === 'close_room' && r.roomId && String(r.roomId) === String(roomId));
    if (roomBlocked) {
      return {
        blocked: true,
        type: 'close_room',
        message: roomBlocked.message || null,
      };
    }
  }

  return { blocked: false, type: null, message: null };
}

async function suggestAlternativeSlot({ business, reservation }) {
  // Vacation is required lazily: restaurant-only model, avoids a hard
  // dependency for callers (e.g. availability listings) that never hit this path.
  const Vacation = require('../models/Vacation');
  const maxDaysAhead = 14;
  const today = new Date(`${reservation.date}T00:00:00`);
  const businessId = reservation.businessId;
  for (let i = 0; i < maxDaysAhead; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = d.toISOString().slice(0, 10);

    const closed = await Vacation.findOne({
      businessId,
      startDate: { $lte: date },
      endDate: { $gte: date },
    }).select('_id');
    if (closed) continue;

    const slots = await getApplicableShiftSlotsForDate(businessId, date);
    if (slots.length === 0) continue;

    for (const slot of slots) {
      const { time, shiftName } = slot;
      if (date === reservation.date && time === reservation.time) continue;

      const blocked = await getExceptionBlocksForShift({
        businessId,
        date,
        shiftName,
      });
      if (blocked.blocked) continue;

      if (!business.maxPeoplePerSlot) return { date, time };

      const used = await getSlotLoad({
        businessId,
        date,
        time,
        durationMinutes: business.reservationDuration || 0,
      });
      if (used + reservation.people <= business.maxPeoplePerSlot) {
        return { date, time };
      }
    }
  }
  return null;
}

/**
 * Read-only slot listing for a date: shift slots minus date/shift exceptions
 * and minus slots that would reject on capacity. Does not check "already
 * passed" or minBookingNoticeHours — those depend on the moment of booking,
 * not on the slot itself, so callers (controllers, future AI tools) apply them.
 */
async function getAvailableSlots({ business, businessId, date, people, roomId = null }) {
  const shiftSlots = await getApplicableShiftSlotsForDate(businessId, date);
  const results = [];
  for (const slot of shiftSlots) {
    const exceptionCheck = await getExceptionBlocksForShift({
      businessId,
      date,
      shiftName: slot.shiftName,
      roomId,
    });
    if (exceptionCheck.blocked) continue;

    const decision = await evaluateReservationStatus({ business, businessId, date, time: slot.time, people });
    if (decision.status === 'rejected_capacity') continue;

    results.push({
      date,
      time: slot.time,
      shiftName: slot.shiftName,
      status: decision.status,
      pendingReason: decision.pendingReason,
    });
  }
  return results;
}

module.exports = {
  BLOCKING_EXCEPTION_TYPES,
  ALL_SHIFTS_KEY,
  generateSlots,
  getApplicableShiftSlotsForDate,
  getApplicableSlotsForDate,
  getSlotLoad,
  evaluateReservationStatus,
  getExceptionBlocksForShift,
  suggestAlternativeSlot,
  getAvailableSlots,
};
