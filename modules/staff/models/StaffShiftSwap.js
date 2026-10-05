const mongoose = require('mongoose');

/**
 * type 'give':     fromEmployee gives assignment away (to toEmployee, or to anyone).
 * type 'exchange': fromEmployee and toEmployee swap assignment <-> counterAssignment.
 * type 'open':     the manager opens a shift (slot) that nobody has yet; anyone can claim it.
 */
const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  type: { type: String, enum: ['give', 'exchange', 'open'], default: 'give' },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffAssignment', default: null },
  counterAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffAssignment', default: null },
  slot: {
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    roleLabel: { type: String, default: '' },
  },
  date: { type: String, required: true },
  counterDate: { type: String, default: '' },
  fromEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null },
  toEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null }, // null = anyone
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null },
  createdBy: { type: String, enum: ['employee', 'manager'], default: 'employee' },
  note: { type: String, default: '' },
  status: { type: String, enum: ['pending_peer', 'pending_manager', 'approved', 'rejected', 'declined', 'cancelled'], default: 'pending_peer' },
  decidedBy: { type: String, default: '' },
  decidedAt: { type: Date, default: null },
  decisionNote: { type: String, default: '' },
}, { timestamps: true });

schema.index({ businessId: 1, status: 1, date: 1 });
schema.index({ businessId: 1, assignmentId: 1 });

module.exports = mongoose.model('StaffShiftSwap', schema);
