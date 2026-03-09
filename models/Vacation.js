const mongoose = require('mongoose');

const vacationSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  startDate:  { type: String, required: true },  // 'YYYY-MM-DD'
  endDate:    { type: String, required: true },  // 'YYYY-MM-DD'
  reason:     { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Vacation', vacationSchema);
