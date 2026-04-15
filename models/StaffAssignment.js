const mongoose = require('mongoose');

const staffAssignmentSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', required: true, index: true },
  date: { type: String, required: true, index: true }, // YYYY-MM-DD
  shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
  startTime: { type: String, default: '' }, // HH:MM
  endTime: { type: String, default: '' },   // HH:MM
  roleLabel: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { timestamps: true });

staffAssignmentSchema.index({ businessId: 1, employeeId: 1, date: 1 });

module.exports = mongoose.model('StaffAssignment', staffAssignmentSchema);
