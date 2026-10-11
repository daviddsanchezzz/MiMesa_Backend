const mongoose = require('mongoose');

// Menú del día: a closed price with courses to choose from. One per business; the restaurant
// rewrites it as it changes (a week, a day). Texts are { es: …, en: … }.
const optionSchema = new mongoose.Schema({
  name: { type: mongoose.Schema.Types.Mixed, default: {} },
  allergens: { type: [String], default: [] },
}, { _id: false });

const courseSchema = new mongoose.Schema({
  name: { type: mongoose.Schema.Types.Mixed, default: {} },     // "Primeros", "Segundos", "Postre"
  options: { type: [optionSchema], default: [] },
}, { _id: false });

const dailyMenuSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  active:   { type: Boolean, default: false },
  title:    { type: mongoose.Schema.Types.Mixed, default: {} },    // "Menú del día"
  includes: { type: mongoose.Schema.Types.Mixed, default: {} },    // "Pan, bebida y postre o café"
  price:    { type: Number, default: null, min: 0 },
  days:     { type: [Number], default: [] },                       // 0 = Sunday … 6; empty = every day
  from:     { type: String, default: '' },                         // YYYY-MM-DD, empty = no start
  to:       { type: String, default: '' },
  courses:  { type: [courseSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('DailyMenu', dailyMenuSchema);
