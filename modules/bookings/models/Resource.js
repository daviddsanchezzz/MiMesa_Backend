const mongoose = require('mongoose');

/**
 * Anything or anyone with its own agenda that a service needs:
 * a hairdresser, a therapist, a room, a table, a van.
 */
const resourceSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  kind:       { type: String, enum: ['staff', 'space', 'equipment'], required: true },
  name:       { type: String, required: true, trim: true, maxlength: 100 },
  parentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'BookingResource', default: null },
  // Clients served at the same time (a person = 1, a table = seats)
  capacity:    { type: Number, default: 1, min: 1, max: 500 },
  minCapacity: { type: Number, default: 1, min: 1, max: 500 },
  staffEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffEmployee', default: null },
  bookableOnline:  { type: Boolean, default: true },
  sortOrder:  { type: Number, default: 0 },
  // How it shows in the agenda: a colour and an optional small photo (data URL)
  color:      { type: String, default: null },
  photo:      { type: String, default: null },
  // Sector-specific extras (colour in the agenda, table shape...)
  attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
  active:     { type: Boolean, default: true },
}, { timestamps: true });

resourceSchema.index({ businessId: 1, kind: 1, active: 1 });

module.exports = mongoose.model('BookingResource', resourceSchema);
