const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffAssignment', required: true },
  date: { type: String, required: true },
  fromEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', required: true },
  toEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null }, // null = anyone
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null },
  note: { type: String, default: '' },
  status: { type: String, enum: ['pending_peer', 'pending_manager', 'approved', 'rejected', 'declined', 'cancelled'], default: 'pending_peer' },
  decidedBy: { type: String, default: '' },
  decidedAt: { type: Date, default: null },
  decisionNote: { type: String, default: '' },
}, { timestamps: true });

schema.index({ businessId: 1, status: 1, date: 1 });
schema.index({ businessId: 1, assignmentId: 1 });

module.exports = mongoose.model('StaffShiftSwap', schema);
