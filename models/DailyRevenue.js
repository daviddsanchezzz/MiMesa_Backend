const mongoose = require('mongoose');

const dailyRevenueSchema = new mongoose.Schema({
  businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  date:          { type: String, required: true }, // YYYY-MM-DD
  actualRevenue: { type: Number, default: null },  // null = not entered yet
  notes:         { type: String, default: '' },
}, { timestamps: true });

// One record per business per day
dailyRevenueSchema.index({ businessId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyRevenue', dailyRevenueSchema);
