const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const businessSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  // password is kept for legacy users (JWT auth). Better Auth users have no password here.
  password:  { type: String, required: false, default: null },
  phone:     { type: String, default: '' },
  address:   { type: String, default: '' },
  cif:       { type: String, default: '' },
  brandColor:  { type: String, default: '#3B82F6' },
  maxReservationPeople: { type: Number, default: 20, min: 1 },
  maxPeoplePerSlot: { type: Number, default: null },
  reservationDuration: { type: Number, default: null },
  minBookingNoticeHours: { type: Number, default: 0, min: 0 },
  requireApprovalAbove: { type: Number, default: null, min: 1 },
  reminderHoursBefore: { type: Number, default: 24, min: 1, max: 168 },
  // Better Auth user ID that owns this business (null for legacy users)
  ownerId: { type: String, default: null, index: true },

  // ── Stripe / subscriptions ───────────────────────────────────────────────
  stripeCustomerId:     { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },
  // Plan: 'free' | 'basic' | 'pro'  — add more as needed
  plan:                 { type: String, default: 'free' },
  // Mirrors Stripe subscription status: active | trialing | past_due | canceled | incomplete | null
  subscriptionStatus:   { type: String, default: null },
  trialEndsAt:          { type: Date,    default: null },
  currentPeriodStart:   { type: Date,    default: null },
  currentPeriodEnd:     { type: Date,    default: null },
  cancelAtPeriodEnd:    { type: Boolean, default: false },

  // ── Stripe Connect (pagos de clientes al restaurante) ────────────────────
  stripeConnectId:      { type: String, default: null },
  stripeConnectEnabled: { type: Boolean, default: false },

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

  // Module-level tenant overrides, e.g.:
  // moduleOverrides.staff.enabled = false
  moduleOverrides: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

businessSchema.pre('save', async function (next) {
  // Only hash if password exists and was modified
  if (!this.password || !this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

businessSchema.methods.matchPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('Business', businessSchema);
