const mongoose = require('mongoose');

// Processed webhook events, used to make delivery idempotent. Entries expire after 30 days.
const stripeEventSchema = new mongoose.Schema({
  eventId:     { type: String, required: true, unique: true },
  type:        { type: String, default: '' },
  processedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

module.exports = mongoose.model('StripeEvent', stripeEventSchema);
