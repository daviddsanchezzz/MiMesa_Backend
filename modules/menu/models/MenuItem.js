const mongoose = require('mongoose');

// A dish. Name and description are { es: …, en: … }. A price that comes from the POS (TPV) is
// locked here (priceSource 'tpv'): the till is the one that charges, so the menu must agree with it.
const menuItemSchema = new mongoose.Schema({
  businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  categoryId:  { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory', required: true },
  name:        { type: mongoose.Schema.Types.Mixed, default: {} },
  description: { type: mongoose.Schema.Types.Mixed, default: {} },
  price:       { type: Number, default: null, min: 0 },       // euros, IVA included; null = "consultar"
  priceSource: { type: String, enum: ['manual', 'tpv'], default: 'manual' },
  externalId:  { type: String, default: '', maxlength: 100 },  // the article code in the POS
  allergens:   { type: [String], default: [] },
  tags:        { type: [String], default: [] },
  // Extras the customer can add ("Masa sin gluten +5 €", "Extra de queso +1,50 €"): { name: {es,…}, price, allergens }
  extras:      { type: [new mongoose.Schema({ name: { type: mongoose.Schema.Types.Mixed, default: {} }, price: { type: Number, default: null, min: 0 }, allergens: { type: [String], default: [] } }, { _id: false })], default: [] },
  photo:       { type: new mongoose.Schema({ url: String, key: String }, { _id: false }), default: undefined },
  sortOrder:   { type: Number, default: 0 },
  soldOut:     { type: Boolean, default: false },   // "agotado hoy"
  hidden:      { type: Boolean, default: false },   // not shown on the website
  retired:     { type: Boolean, default: false },   // no longer in the POS (a person decides what to do)
}, { timestamps: true });

menuItemSchema.index({ businessId: 1, categoryId: 1, sortOrder: 1 });
menuItemSchema.index({ businessId: 1, externalId: 1 });

module.exports = mongoose.model('MenuItem', menuItemSchema);
