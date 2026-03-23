const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:       { type: String, required: true },
  phone:      { type: String, default: '' },
  email:      { type: String, default: '', lowercase: true },
  notes:      { type: String, default: '' },
  visits:     { type: Number, default: 0 },
  noShowCount:{ type: Number, default: 0 },
  // Marketing consent
  marketingSubscribed:     { type: Boolean, default: false },
  marketingSubscribedAt:   { type: Date,    default: null },
  marketingUnsubscribed:   { type: Boolean, default: false },
  marketingUnsubscribedAt: { type: Date,    default: null },
  unsubscribeToken:        { type: String,  default: null, index: true },
}, { timestamps: true });

module.exports = mongoose.model('Customer', customerSchema);
