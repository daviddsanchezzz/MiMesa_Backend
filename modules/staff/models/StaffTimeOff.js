const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', required: true },
  type: { type: String, enum: ['vacation', 'day_off', 'unavailable'], required: true },
  from: { type: String, required: true },      // YYYY-MM-DD
  to: { type: String, required: true },        // YYYY-MM-DD (same as from for one day)
  fromTime: { type: String, default: '' },     // optional partial day, HH:MM
  toTime: { type: String, default: '' },
  note: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  requestedBy: { type: String, enum: ['employee', 'manager'], default: 'employee' },
  decidedBy: { type: String, default: '' },
  decidedAt: { type: Date, default: null },
  decisionNote: { type: String, default: '' },
}, { timestamps: true });

schema.index({ businessId: 1, employeeId: 1, from: 1 });
schema.index({ businessId: 1, status: 1, from: 1 });

module.exports = mongoose.model('StaffTimeOff', schema);
