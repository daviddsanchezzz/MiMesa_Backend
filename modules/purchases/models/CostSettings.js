const mongoose = require('mongoose');

// How the restaurant wants to be warned: a price rise of this percentage or more.
const costSettingsSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  alertPct: { type: Number, default: 5, min: 1, max: 100 },
  targetMarginPct: { type: Number, default: 70, min: 1, max: 95 },   // the margin each dish should reach
  vatPct: { type: Number, default: 10, min: 0, max: 30 },            // VAT included in the carta prices (10 % in restaurants)
}, { timestamps: true });

module.exports = mongoose.model('CostSettings', costSettingsSchema);
