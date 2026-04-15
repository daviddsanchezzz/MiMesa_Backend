const mongoose = require('mongoose');

const staffEmployeeSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, default: '', trim: true },
  phone: { type: String, default: '', trim: true },
  email: { type: String, default: '', lowercase: true, trim: true },
  positionId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffPosition', default: null, index: true },
  position: { type: String, default: '', trim: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  notes: { type: String, default: '' },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

staffEmployeeSchema.index({ businessId: 1, email: 1 });

module.exports = mongoose.model('StaffEmployee', staffEmployeeSchema);
