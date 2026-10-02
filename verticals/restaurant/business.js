/**
 * What the restaurant vertical adds to the core Business document.
 * The fields live at the top level of the Business document in MongoDB
 * (unchanged from before), they are just declared here instead of in core.
 */

const fields = {
  maxReservationPeople: { type: Number, default: 20, min: 1 },
  maxPeoplePerSlot: { type: Number, default: null },
  reservationDuration: { type: Number, default: null },
  minBookingNoticeHours: { type: Number, default: 0, min: 0 },
  requireApprovalAbove: { type: Number, default: null, min: 1 },
  reminderHoursBefore: { type: Number, default: 24, min: 1, max: 168 },

  // ── Config de pagos en reservas ──────────────────────────────────────────
  reservationPayment: {
    enabled:                { type: Boolean, default: false },
    mode:                   { type: String, enum: ['none', 'deposit'], default: 'none' },
    depositAmount:          { type: Number, default: 0 },   // céntimos, ej: 500 = 5€
    depositPerPerson:       { type: Boolean, default: false }, // true = por persona, false = fijo
    noShowFeeAmount:        { type: Number, default: 0 },   // céntimos
    freeCancellationHours:  { type: Number, default: 24 },  // horas antes de la reserva
    currency:               { type: String, default: 'eur' },
  },

  // ── Finanzas config ──────────────────────────────────────────────────────────
  ticketAverage: { type: Number, default: 25, min: 0 }, // euros por comensal
};

// Fields the public booking page may read.
const publicFields = 'maxReservationPeople maxPeoplePerSlot reservationDuration minBookingNoticeHours';

// Extra properties in the business payload sent to the app.
function serialize(b) {
  return {
    maxReservationPeople: b.maxReservationPeople,
    maxPeoplePerSlot: b.maxPeoplePerSlot ?? null,
    reservationDuration: b.reservationDuration ?? null,
    minBookingNoticeHours: b.minBookingNoticeHours ?? 0,
    requireApprovalAbove: b.requireApprovalAbove ?? null,
    reminderHoursBefore: b.reminderHoursBefore ?? 24,
  };
}

// Settings the owner can change from the app (PUT business settings).
function applyUpdate(body, updateData) {
  const { maxReservationPeople, maxPeoplePerSlot, requireApprovalAbove, reminderHoursBefore, minBookingNoticeHours } = body;
  if (maxReservationPeople !== undefined) updateData.maxReservationPeople = maxReservationPeople;
  if (maxPeoplePerSlot !== undefined) updateData.maxPeoplePerSlot = maxPeoplePerSlot;
  if (body.reservationDuration !== undefined) updateData.reservationDuration = body.reservationDuration;
  if (requireApprovalAbove !== undefined) updateData.requireApprovalAbove = requireApprovalAbove;
  if (minBookingNoticeHours !== undefined) updateData.minBookingNoticeHours = minBookingNoticeHours === null || minBookingNoticeHours === '' ? 0 : Number(minBookingNoticeHours);
  if (reminderHoursBefore !== undefined) updateData.reminderHoursBefore = reminderHoursBefore;
}

module.exports = { fields, publicFields, serialize, applyUpdate };
