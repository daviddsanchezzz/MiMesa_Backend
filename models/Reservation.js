const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  roomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room',     default: null },
  tableId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Table',    default: null },
  tableIds:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Table' }],
  // Guest data (always stored, used for display when no customer)
  guestName:  { type: String, required: true },
  guestPhone: { type: String, default: '' },
  guestEmail: { type: String, default: '', lowercase: true },
  date:       { type: String, required: true }, // 'YYYY-MM-DD'
  time:       { type: String, required: true }, // 'HH:MM'
  people:     { type: Number, required: true, min: 1 },
  status:     { type: String, enum: ['pending', 'confirmed', 'cancelled', 'seated', 'no_show'], default: 'confirmed' },
  pendingReason: { type: String, enum: ['slot_capacity', 'large_group', 'manual', 'none'], default: 'none' },
  proposedAlternative: {
    date: { type: String, default: null },   // 'YYYY-MM-DD'
    time: { type: String, default: null },   // 'HH:MM'
    message: { type: String, default: '' },
    proposedAt: { type: Date, default: null },
  },
  reminderSentAt: { type: Date, default: null },
  notes:      { type: String, default: '' },
  promoCode:   { type: String,  default: '' },
  promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', default: null },
  consent:               { type: Boolean, default: false },
  marketingConsent:      { type: Boolean, default: false },
  marketingConsentAt:    { type: Date,   default: null },
  marketingConsentText:  { type: String, default: '' },

  // ── Pago ─────────────────────────────────────────────────────────────────
  payment: {
    // 'none' | 'deposit' | 'card_guarantee'  — snapshot del modo al crear la reserva
    mode:                   { type: String, default: 'none' },
    // 'none' | 'pending' | 'captured' | 'refunded' | 'failed'
    status:                 { type: String, default: 'none' },
    amount:                 { type: Number, default: 0 },  // céntimos cobrados/retenidos
    currency:               { type: String, default: 'eur' },
    stripePaymentIntentId:  { type: String, default: null }, // modo depósito
    stripeSetupIntentId:    { type: String, default: null }, // modo garantía
    stripePaymentMethodId:  { type: String, default: null }, // tarjeta guardada
    stripeCustomerId:       { type: String, default: null }, // Stripe customer del huésped
    capturedAt:             { type: Date,   default: null },
    refundedAt:             { type: Date,   default: null },
  },
}, { timestamps: true });

module.exports = mongoose.model('Reservation', reservationSchema);
