const mongoose = require('mongoose');

const reminderLogSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  reservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', required: true, index: true },
  type: { type: String, enum: ['reservation_reminder'], required: true },
  status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
  sentAt: { type: Date, default: Date.now },
  error: { type: String, default: '' },
}, { timestamps: true });

reminderLogSchema.index({ reservationId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('ReminderLog', reminderLogSchema);
