const mongoose = require('mongoose');

/**
 * What customers can do with their appointment from the link in their emails.
 * One per business; without a document the defaults apply (change or cancel
 * online until the appointment starts).
 */
const bookingPolicySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  // Minimum hours before the appointment to cancel or change it online (0 = until it starts)
  changeMinHours: { type: Number, default: 0, min: 0, max: 168 },
  // Customers can pick a new day/time themselves
  allowReschedule: { type: Boolean, default: true },
  // Free text shown on the booking page and the manage page ("Si no avisas…")
  note: { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

module.exports = mongoose.model('BookingPolicy', bookingPolicySchema);
