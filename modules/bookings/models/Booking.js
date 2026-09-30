const mongoose = require('mongoose');
const crypto = require('crypto');

const segmentSchema = new mongoose.Schema({
  serviceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'BookingService', required: true },
  serviceName: { type: String, default: '' },          // snapshot for history
  start:       { type: Date, required: true },
  end:         { type: Date, required: true },
  // start/end widened by the service buffers: what the resources are blocked for
  busyStart:   { type: Date, required: true },
  busyEnd:     { type: Date, required: true },
  resourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BookingResource' }],
  anyStaff:    { type: Boolean, default: false },
  price:       { type: Number, default: 0 },           // cents, snapshot
}, { _id: true });

// What was charged when the appointment ended (Caja). Money in cents.
const paymentSchema = new mongoose.Schema({
  method:   { type: String, enum: ['cash', 'card', 'bizum', 'other'], required: true },
  services: { type: Number, default: 0 },   // appointment price charged
  extras:   [{ _id: false, name: { type: String, maxlength: 100 }, price: Number, qty: { type: Number, default: 1 } }],
  discount: { type: Number, default: 0 },
  tip:      { type: Number, default: 0 },   // not revenue: goes to the team
  total:    { type: Number, default: 0 },   // services + extras - discount
  date:     { type: String, required: true }, // business-local YYYY-MM-DD of paidAt (the till day)
  paidAt:   { type: Date, required: true },
  paidBy:   { type: String, default: null },
  note:     { type: String, default: '', maxlength: 300 },
}, { _id: false });

/**
 * A customer's appointment. One or more consecutive segments, each a service
 * with the resources it occupies ("corte con Ana" + "tinte con Luis").
 */
const bookingSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  guestName:  { type: String, required: true, maxlength: 100 },
  guestPhone: { type: String, default: '', maxlength: 30 },
  guestEmail: { type: String, default: '', lowercase: true, maxlength: 200 },

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'],
    default: 'confirmed',
  },
  start: { type: Date, required: true },
  end:   { type: Date, required: true },
  partySize: { type: Number, default: 1, min: 1 },
  segments:  { type: [segmentSchema], validate: (v) => Array.isArray(v) && v.length > 0 },

  source: { type: String, enum: ['online', 'phone', 'walk_in', 'staff'], default: 'staff' },
  notes:         { type: String, default: '', maxlength: 1000 },
  internalNotes: { type: String, default: '', maxlength: 2000 },
  totalPrice:    { type: Number, default: 0 },          // cents
  cancelledAt:   { type: Date, default: null },
  reminderSentAt:{ type: Date, default: null },   // 24h reminder email already sent
  // Follow-up emails, at most one of each per visit (see followUpsService)
  reviewRequestedAt:    { type: Date, default: null },
  rebookReminderSentAt: { type: Date, default: null },
  payment:       { type: paymentSchema, default: null },
  createdBy:     { type: String, default: null },       // user id, null for online
  // Secret for the guest's cancel link
  publicToken:   { type: String, default: () => crypto.randomBytes(24).toString('hex'), index: true },
}, { timestamps: true });

bookingSchema.index({ businessId: 1, start: 1 });
bookingSchema.index({ status: 1, reminderSentAt: 1, start: 1 });
bookingSchema.index({ businessId: 1, customerId: 1, start: -1 });
bookingSchema.index({ businessId: 1, 'payment.date': 1 }, { sparse: true });

module.exports = mongoose.model('Booking', bookingSchema);
