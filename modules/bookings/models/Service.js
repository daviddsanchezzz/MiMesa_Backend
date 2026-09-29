const mongoose = require('mongoose');

const requirementSchema = new mongoose.Schema({
  kind:     { type: String, enum: ['staff', 'space', 'equipment'], required: true },
  count:    { type: Number, default: 1, min: 1, max: 10 },
  // Empty = any active resource of this kind
  resourceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BookingResource' }],
  optional: { type: Boolean, default: false },
  // The customer may pick which one (e.g. "con Ana")
  customerCanChoose: { type: Boolean, default: false },
  // Resource capacity must fit the party size (tables)
  matchPartySize: { type: Boolean, default: false },
}, { _id: false });

/**
 * What the business offers: how long it takes, which resources it uses,
 * how it is booked and how it is charged.
 */
const serviceSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:       { type: String, required: true, trim: true, maxlength: 120 },
  category:   { type: String, default: '', maxlength: 60 },
  description:{ type: String, default: '', maxlength: 1000 },

  durationMin:     { type: Number, required: true, min: 5, max: 24 * 60 },
  bufferBeforeMin: { type: Number, default: 0, min: 0, max: 240 },
  bufferAfterMin:  { type: Number, default: 0, min: 0, max: 240 },
  slotIntervalMin: { type: Number, default: 15, min: 5, max: 240 },

  bookingMode:  { type: String, enum: ['slot', 'quote'], default: 'slot' },
  capacityMode: { type: String, enum: ['resource', 'pool'], default: 'resource' },
  poolCapacity: { type: Number, default: null, min: 1 },     // max people at once (capacityMode 'pool')
  partySize: {
    min: { type: Number, default: 1, min: 1 },
    max: { type: Number, default: 1, min: 1 },
  },
  requirements: { type: [requirementSchema], default: [] },

  price: {
    amount:   { type: Number, default: 0, min: 0 },    // cents
    currency: { type: String, default: 'eur' },
    from:     { type: Boolean, default: false },       // "desde 25 €"
    perPerson:{ type: Boolean, default: false },
  },
  tax: {
    rate:         { type: Number, default: 21, min: 0, max: 100 },
    exemptReason: { type: String, default: null },     // e.g. 'art20_sanitario'
  },
  onlineBooking: {
    enabled:         { type: Boolean, default: true },
    minNoticeHours:  { type: Number, default: 0, min: 0 },
    maxDaysAhead:    { type: Number, default: 60, min: 1, max: 730 },
    requireApproval: { type: Boolean, default: false },
  },
  staffCommissionPercent: { type: Number, default: null, min: 0, max: 100 },
  active:    { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('BookingService', serviceSchema);
