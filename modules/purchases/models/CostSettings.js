const mongoose = require('mongoose');

// How the restaurant wants to be warned: a price rise of this percentage or more.
const costSettingsSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  alertPct: { type: Number, default: 5, min: 1, max: 100 },
}, { timestamps: true });

module.exports = mongoose.model('CostSettings', costSettingsSchema);
