const mongoose = require('mongoose');
const { DEFAULT_LANGUAGES } = require('../lib/constants');

// One per business: the languages the menu is written in (the first is the main one).
const menuSettingsSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  languages:  { type: [String], default: DEFAULT_LANGUAGES },
}, { timestamps: true });

module.exports = mongoose.model('MenuSettings', menuSettingsSchema);
