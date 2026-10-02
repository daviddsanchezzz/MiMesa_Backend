const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  roomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  name:       { type: String, required: true },
  capacity:   { type: Number, required: true, min: 1 },
  // booth = banco corrido (benches on the long sides instead of chairs)
  shape:      { type: String, enum: ['circle', 'square', 'rect', 'booth'], default: null },
  // Degrees, in steps of 15 (0 = horizontal, 90 = vertical).
  angle:      { type: Number, min: 0, max: 345, default: 0 },
  status:     { type: String, enum: ['free', 'reserved', 'occupied'], default: 'free' },
  x:          { type: Number, default: null },
  y:          { type: Number, default: null },
}, { timestamps: true });

tableSchema.index({ businessId: 1, roomId: 1 });

module.exports = mongoose.model('Table', tableSchema);
