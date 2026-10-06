const mongoose = require('mongoose');

// What the restaurant's website shows that is neither the menu nor already defined elsewhere: how to book
// and where to find them online. Opening hours and closures come from the turnos, vacations and closure
// exceptions the restaurant already has; phone, address and email from the business data. One per business.
const siteProfileSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  reservations: {
    mode: { type: String, enum: ['none', 'vetra', 'link', 'phone'], default: 'vetra' },
    url: { type: String, default: '', maxlength: 300 },    // mode 'link': another booking system (TheFork…)
  },
  social: {
    instagram: { type: String, default: '', maxlength: 200 },
    facebook: { type: String, default: '', maxlength: 200 },
    tiktok: { type: String, default: '', maxlength: 200 },
    youtube: { type: String, default: '', maxlength: 200 },
    whatsapp: { type: String, default: '', maxlength: 30 },
  },
}, { timestamps: true });

module.exports = mongoose.model('SiteProfile', siteProfileSchema);
