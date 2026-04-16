const mongoose = require('mongoose');

const staffPaymentSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'EUR', uppercase: true },
  notes: { type: String, default: '' },
  paidAt: { type: Date, default: Date.now },
}, { timestamps: true });

staffPaymentSchema.index({ businessId: 1, employeeId: 1, paidAt: -1 });

module.exports = mongoose.model('StaffPayment', staffPaymentSchema);
