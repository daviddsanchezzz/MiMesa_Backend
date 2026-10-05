const mongoose = require('mongoose');

const marketingCampaignSchema = new mongoose.Schema({
  businessId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  subject:        { type: String, required: true },
  body:           { type: String, required: true },
  recipientCount: { type: Number, default: 0 },
  audience:       { type: String, default: '' },   // who it was for (empty = every subscriber)
  status:         { type: String, enum: ['sending', 'sent', 'failed'], default: 'sent' },
  sentAt:         { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('MarketingCampaign', marketingCampaignSchema);
