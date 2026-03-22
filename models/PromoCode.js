const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema({
  businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  code:        { type: String, required: true },
  description: { type: String, default: '' },   // e.g. "10% dto en tu próxima visita"
  active:      { type: Boolean, default: true },
  expiresAt:   { type: Date,   default: null },  // null = no expira
  maxUses:     { type: Number, default: null },  // null = ilimitado
  usedCount:   { type: Number, default: 0 },
}, { timestamps: true });

promoCodeSchema.index({ businessId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('PromoCode', promoCodeSchema);
