const mongoose = require('mongoose');

/**
 * Automatic emails after a visit, per business. Both are commercial emails
 * (LSSI): only to people who already came, with a one-click opt-out in
 * every email, and never more than one per visit.
 */
const followUpSettingsSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  // "Te toca volver": when a customer is past their usual rhythm and has nothing booked
  rebook: {
    enabled:     { type: Boolean, default: false },
    lastRunDate: { type: String, default: null }, // business-local YYYY-MM-DD of the last daily run
  },
  // "¿Qué tal tu visita?": a few hours after an attended appointment, link to Google
  review: {
    enabled:    { type: Boolean, default: false },
    url:        { type: String, default: '', maxlength: 500 },
    delayHours: { type: Number, default: 3, min: 1, max: 48 },
  },
}, { timestamps: true });

module.exports = mongoose.model('BookingFollowUpSettings', followUpSettingsSchema);
