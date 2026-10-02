const mongoose = require('mongoose');

const staffEmployeeSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, default: '', trim: true },
  phone: { type: String, default: '', trim: true },
  email: { type: String, default: '', lowercase: true, trim: true },
  positionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'StaffPosition' }],
  positionId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffPosition', default: null, index: true },
  position: { type: String, default: '', trim: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  notes: { type: String, default: '' },
  color: { type: String, default: '#7C3AED', trim: true },
  services: [{
    name: { type: String, required: true, trim: true },
    duration: { type: Number, default: 30, min: 5 },
    price: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  }],
  scheduleMode: { type: String, enum: ['business', 'custom'], default: 'business' },
  weeklySchedule: { type: mongoose.Schema.Types.Mixed, default: {} },
  vacations: [{
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    reason: { type: String, default: '' },
  }],
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessMember', default: null, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

staffEmployeeSchema.index({ businessId: 1, email: 1 });

module.exports = mongoose.model('StaffEmployee', staffEmployeeSchema);
