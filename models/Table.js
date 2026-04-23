const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  roomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  name:       { type: String, required: true },
  capacity:   { type: Number, required: true, min: 1 },
  shape:      { type: String, enum: ['circle', 'square', 'rect'], default: null },
  angle:      { type: Number, enum: [0, 90], default: 0 },
  status:     { type: String, enum: ['free', 'reserved', 'occupied'], default: 'free' },
  x:          { type: Number, default: null },
  y:          { type: Number, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Table', tableSchema);
