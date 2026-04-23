const mongoose = require('mongoose');

const exceptionSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  date: { type: String, required: true, index: true }, // YYYY-MM-DD
  shiftName: { type: String, required: true, trim: true, index: true },
  type: {
    type: String,
    enum: ['closed', 'full', 'call', 'close_room'],
    required: true,
    index: true,
  },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  message: { type: String, default: '' },
}, { timestamps: true });

exceptionSchema.index({ businessId: 1, date: 1, shiftName: 1, type: 1, roomId: 1 });

module.exports = mongoose.model('Exception', exceptionSchema);

