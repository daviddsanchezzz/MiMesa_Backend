const mongoose = require('mongoose');

/**
 * Loyalty rule of a business: every Nth paid visit earns a reward (a % or a
 * fixed amount off). Off by default; one per business.
 */
const loyaltySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  enabled:    { type: Boolean, default: false },
  every:      { type: Number, default: 10, min: 2, max: 100 },   // the Nth visit gets the reward
  reward: {
    type:  { type: String, enum: ['percent', 'amount'], default: 'percent' },
    value: { type: Number, default: 10, min: 1 },                // percent (1-100) or cents
  },
}, { timestamps: true });

module.exports = mongoose.model('BookingLoyaltySettings', loyaltySchema);
