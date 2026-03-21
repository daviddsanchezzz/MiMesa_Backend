const mongoose = require('mongoose');

const featureSchema = new mongoose.Schema({
  text:     { type: String, required: true },
  included: { type: Boolean, default: true },
}, { _id: false });

const planSchema = new mongoose.Schema({
  id:            { type: String, required: true },   // 'free' | 'basic' | 'pro' | any custom key
  name:          { type: String, required: true },
  price:         { type: Number, required: true },
  period:        { type: String, default: 'mes' },
  description:   { type: String, default: '' },
  featured:      { type: Boolean, default: false },
  featuredLabel: { type: String, default: '' },
  features:      { type: [featureSchema], default: [] },
  cta:           { type: String, default: 'Empezar' },
  ctaStyle:      { type: String, default: 'outline' }, // 'primary' | 'outline'
  visible:       { type: Boolean, default: true },
  order:         { type: Number, default: 0 },
}, { _id: false });

const pricingConfigSchema = new mongoose.Schema({
  plans: { type: [planSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('PricingConfig', pricingConfigSchema);
