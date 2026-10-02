const mongoose = require('mongoose');

/**
 * One document per resource per time cell it is busy (see lib/occupancy.js).
 * The unique index makes double-booking impossible at database level, even
 * with several server instances or two customers clicking at the same time.
 */
const occupancySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, required: true },
  resourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  cell:       { type: Date, required: true },     // start of the cell (UTC)
  bookingId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
});

occupancySchema.index({ resourceId: 1, cell: 1 }, { unique: true });

module.exports = mongoose.model('BookingOccupancy', occupancySchema);
