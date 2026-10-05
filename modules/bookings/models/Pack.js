const mongoose = require('mongoose');

/**
 * A pack ("bono") the business sells: N sessions of some services for a
 * price paid up front ("5 sesiones de láser"). Money in cents.
 */
const packSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:       { type: String, required: true, trim: true, maxlength: 80 },
  sessions:   { type: Number, required: true, min: 2, max: 200 },
  price:      { type: Number, required: true, min: 0, max: 10_000_00 },
  // Services the pack can be used for; empty = any service
  serviceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BookingService' }],
  // Days the pack lasts from the sale; null = it does not expire
  validityDays: { type: Number, default: null, min: 1, max: 1825 },
  active:     { type: Boolean, default: true },
  sortOrder:  { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('BookingPack', packSchema);
