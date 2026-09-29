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
  createdBy:     { type: String, default: null },       // user id, null for online
  // Secret for the guest's cancel link
  publicToken:   { type: String, default: () => crypto.randomBytes(24).toString('hex'), index: true },
}, { timestamps: true });

bookingSchema.index({ businessId: 1, start: 1 });
bookingSchema.index({ businessId: 1, customerId: 1, start: -1 });

module.exports = mongoose.model('Booking', bookingSchema);
