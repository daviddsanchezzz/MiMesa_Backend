const mongoose = require('mongoose');

// "Entrantes", "Postres"… `name` is { es: 'Entrantes', en: 'Starters' } (one entry per language).
const menuCategorySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:       { type: mongoose.Schema.Types.Mixed, default: {} },
  sortOrder:  { type: Number, default: 0 },
  hidden:     { type: Boolean, default: false },   // not shown on the website
}, { timestamps: true });

menuCategorySchema.index({ businessId: 1, sortOrder: 1 });

module.exports = mongoose.model('MenuCategory', menuCategorySchema);
