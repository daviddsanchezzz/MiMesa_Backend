const mongoose = require('mongoose');

// What the restaurant's website shows that is not the menu: opening hours (their own, not the
// reservation turnos), one-off closures, how to book and where to find them. One per business.
const rangeSchema = new mongoose.Schema({ open: String, close: String }, { _id: false });
const daySchema = new mongoose.Schema({ day: Number, ranges: { type: [rangeSchema], default: [] } }, { _id: false });
const closureSchema = new mongoose.Schema({
  from: { type: String, required: true },   // YYYY-MM-DD
  to: { type: String, required: true },
  reason: { type: String, default: '', maxlength: 200 },
}, { _id: false });

const siteProfileSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  openingHours: { type: [daySchema], default: [] },        // day: 0 = Sunday … 6; no ranges = closed
  closures: { type: [closureSchema], default: [] },        // holidays, works, private events
  reservations: {
    mode: { type: String, enum: ['none', 'vetra', 'link', 'phone'], default: 'none' },
    url: { type: String, default: '', maxlength: 300 },    // mode 'link': another booking system (TheFork…)
  },
  social: {
    instagram: { type: String, default: '', maxlength: 200 },
    facebook: { type: String, default: '', maxlength: 200 },
    tiktok: { type: String, default: '', maxlength: 200 },
    youtube: { type: String, default: '', maxlength: 200 },
    whatsapp: { type: String, default: '', maxlength: 30 },
  },
  contactEmail: { type: String, default: '', maxlength: 200, lowercase: true },
  mapsUrl: { type: String, default: '', maxlength: 400 },
}, { timestamps: true });

module.exports = mongoose.model('SiteProfile', siteProfileSchema);
