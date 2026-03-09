const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  roomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  name:       { type: String, required: true },
  capacity:   { type: Number, required: true, min: 1 },
  status:     { type: String, enum: ['free', 'reserved', 'occupied'], default: 'free' },
  x:          { type: Number, default: null },
  y:          { type: Number, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Table', tableSchema);
