const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  roomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room',     default: null },
  tableId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Table',    default: null },
  // Guest data (always stored, used for display when no customer)
  guestName:  { type: String, required: true },
  guestPhone: { type: String, default: '' },
  guestEmail: { type: String, default: '', lowercase: true },
  date:       { type: String, required: true }, // 'YYYY-MM-DD'
  time:       { type: String, required: true }, // 'HH:MM'
  people:     { type: Number, required: true, min: 1 },
  status:     { type: String, enum: ['pending', 'confirmed', 'cancelled', 'seated'], default: 'confirmed' },
  notes:      { type: String, default: '' },
  promoCode:   { type: String,  default: '' },
  promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', default: null },
  consent:               { type: Boolean, default: false },
  marketingConsent:      { type: Boolean, default: false },
  marketingConsentAt:    { type: Date,   default: null },
  marketingConsentText:  { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Reservation', reservationSchema);
