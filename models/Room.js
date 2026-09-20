const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name:        { type: String, required: true },
  capacity:    { type: Number, required: true, min: 1 },
  description: { type: String, default: '' },
}, { timestamps: true });

roomSchema.index({ businessId: 1 });

module.exports = mongoose.model('Room', roomSchema);
