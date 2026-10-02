const mongoose = require('mongoose');

/**
 * Time a professional is not available (holidays, doctor, leaving early…).
 * It blocks the agenda like a booking does: no new appointments are offered
 * or accepted in it. The reason is private (only managers and the person).
 */
const absenceSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  resourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingResource', required: true },
  start:      { type: Date, required: true },
  end:        { type: Date, required: true },
  allDay:     { type: Boolean, default: true },
  // As entered, in business-local time, for display.
  fromDate:   { type: String, required: true },   // YYYY-MM-DD
  toDate:     { type: String, required: true },   // YYYY-MM-DD (inclusive)
  startTime:  { type: String, default: null },    // HH:MM when not all day
  endTime:    { type: String, default: null },
  reason:     { type: String, default: '', maxlength: 200 },
  createdBy:  { type: String, default: null },    // app user id
}, { timestamps: true });

absenceSchema.index({ businessId: 1, start: 1, end: 1 });
absenceSchema.index({ resourceId: 1, start: 1 });

module.exports = mongoose.model('BookingAbsence', absenceSchema);
