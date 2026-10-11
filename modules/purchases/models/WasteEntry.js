const mongoose = require('mongoose');

// Something thrown away or lost: it explains part of the difference between what was bought and what was sold.
const wasteEntrySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  date: { type: String, required: true },   // YYYY-MM-DD
  ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  quantity: { type: Number, required: true, min: 0 },   // in the unit of the ingredient (kg, l, ud)
  reason: { type: String, enum: ['expired', 'broken', 'mistake', 'staff', 'other'], default: 'other' },
  note: { type: String, default: '', maxlength: 300 },
  cost: { type: Number, default: null },    // € at the price of the day it was recorded
}, { timestamps: true });

wasteEntrySchema.index({ businessId: 1, date: -1 });

module.exports = mongoose.model('WasteEntry', wasteEntrySchema);
