const mongoose = require('mongoose');

const marketingCampaignSchema = new mongoose.Schema({
  businessId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  subject:        { type: String, required: true },
  body:           { type: String, required: true },
  recipientCount: { type: Number, default: 0 },
  status:         { type: String, enum: ['sent', 'failed'], default: 'sent' },
  sentAt:         { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('MarketingCampaign', marketingCampaignSchema);
