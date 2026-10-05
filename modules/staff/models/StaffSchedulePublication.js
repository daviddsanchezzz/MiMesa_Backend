const mongoose = require('mongoose');

/** The published version of one week: what employees see in "Mi horario". */
const rowSchema = new mongoose.Schema({
  assignmentId: String, employeeId: String, date: String, shiftId: String, shiftName: String,
  start: String, end: String, roleLabel: String, notes: String,
}, { _id: false });

const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  weekStart: { type: String, required: true }, // Monday, YYYY-MM-DD
  publishedAt: { type: Date, default: Date.now },
  publishedBy: { type: String, default: '' },
  rows: [rowSchema],
}, { timestamps: true });

schema.index({ businessId: 1, weekStart: 1 }, { unique: true });

module.exports = mongoose.model('StaffSchedulePublication', schema);
