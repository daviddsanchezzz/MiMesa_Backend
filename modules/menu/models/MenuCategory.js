const mongoose = require('mongoose');

// "Entrantes", "Postres"… `name` is { es: 'Entrantes', en: 'Starters' } (one entry per language).
const menuCategorySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:       { type: mongoose.Schema.Types.Mixed, default: {} },
  extras:     { type: [new mongoose.Schema({ name: { type: mongoose.Schema.Types.Mixed, default: {} }, price: { type: Number, default: null, min: 0 }, allergens: { type: [String], default: [] } }, { _id: false })], default: [] },   // apply to every dish of the category
  sortOrder:  { type: Number, default: 0 },
  hidden:     { type: Boolean, default: false },   // not shown on the website
}, { timestamps: true });

menuCategorySchema.index({ businessId: 1, sortOrder: 1 });

module.exports = mongoose.model('MenuCategory', menuCategorySchema);
