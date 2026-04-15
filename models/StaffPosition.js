const mongoose = require('mongoose');

const staffPositionSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true },
  color: { type: String, default: '#64748B', trim: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  normalizedName: { type: String, required: true, trim: true },
}, { timestamps: true });

staffPositionSchema.index({ businessId: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('StaffPosition', staffPositionSchema);
