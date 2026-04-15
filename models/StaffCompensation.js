const mongoose = require('mongoose');

const staffCompensationSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', required: true, index: true },
  paymentType: { type: String, enum: ['hourly', 'per_shift', 'monthly_fixed'], required: true },
  baseAmount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'EUR', uppercase: true },
  effectiveFrom: { type: String, required: true }, // YYYY-MM-DD
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

staffCompensationSchema.index({ businessId: 1, employeeId: 1, effectiveFrom: -1 });

module.exports = mongoose.model('StaffCompensation', staffCompensationSchema);
