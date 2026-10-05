const mongoose = require('mongoose');

/**
 * A pack sold to a customer: sessions left, when it expires, what was paid
 * for it (it counts in the till of the day it was sold) and which
 * appointments used its sessions. A snapshot of the pack at the time of sale.
 */
const customerPackSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
  packId:     { type: mongoose.Schema.Types.ObjectId, ref: 'BookingPack', default: null },
  name:       { type: String, required: true, maxlength: 80 },
  sessions:   { type: Number, required: true },
  remaining:  { type: Number, required: true, min: 0 },
  serviceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BookingService' }],
  soldAt:     { type: Date, required: true },
  expiresAt:  { type: Date, default: null },
  payment: {
    method:  { type: String, enum: ['cash', 'card', 'bizum', 'other'], required: true },
    amount:  { type: Number, required: true, min: 0 },   // cents
    date:    { type: String, required: true },            // business-local YYYY-MM-DD of the sale (the till day)
    paidAt:  { type: Date, required: true },
    paidBy:  { type: String, default: null },
    note:    { type: String, default: '', maxlength: 300 },
  },
  uses: [{ _id: false, bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' }, usedAt: Date }],
}, { timestamps: true });

customerPackSchema.index({ businessId: 1, customerId: 1, soldAt: -1 });
customerPackSchema.index({ businessId: 1, 'payment.date': 1 });

module.exports = mongoose.model('BookingCustomerPack', customerPackSchema);
