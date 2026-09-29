const mongoose = require('mongoose');

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const windowSchema = new mongoose.Schema({
  start: { type: String, required: true, match: TIME }, // 'HH:MM' local time
  end:   { type: String, required: true, match: TIME },
}, { _id: false });

const ruleSchema = new mongoose.Schema({
  days:  { type: [Number], default: [1, 2, 3, 4, 5] },   // 0 = domingo … 6 = sábado
  start: { type: String, required: true, match: TIME },
  end:   { type: String, required: true, match: TIME },
  label: { type: String, default: '' },
}, { _id: false });

const overrideSchema = new mongoose.Schema({
  from:    { type: String, required: true, match: DATE },  // inclusive
  to:      { type: String, required: true, match: DATE },  // inclusive (= from for a single day)
  closed:  { type: Boolean, default: false },
  windows: { type: [windowSchema], default: undefined },   // replaces the weekly rules those days
  reason:  { type: String, default: '' },
}, { _id: false });

/**
 * When something is available: weekly rules plus date exceptions.
 * Owned by the business (opening hours) or by one resource (a person's shifts).
 */
const scheduleSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  ownerType:  { type: String, enum: ['business', 'resource'], required: true },
  ownerId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  rules:      { type: [ruleSchema], default: [] },
  overrides:  { type: [overrideSchema], default: [] },
}, { timestamps: true });

scheduleSchema.index({ businessId: 1, ownerType: 1, ownerId: 1 }, { unique: true });

module.exports = mongoose.model('BookingSchedule', scheduleSchema);
