const mongoose = require('mongoose');

/**
 * Proof that a person accepted the legal documents: which ones, which
 * version, when and from where. Never updated, only added.
 */
const legalAcceptanceSchema = new mongoose.Schema({
  userId:     { type: String, required: true, index: true },   // Better Auth user id
  email:      { type: String, required: true, lowercase: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
  role:       { type: String, default: null },
  documents:  { type: [String], required: true },               // terms | privacy | dpa
  version:    { type: String, required: true },
  context:    { type: String, enum: ['invitation', 'onboarding'], required: true },
  ip:         { type: String, default: '' },
  userAgent:  { type: String, default: '' },
  acceptedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('LegalAcceptance', legalAcceptanceSchema);
