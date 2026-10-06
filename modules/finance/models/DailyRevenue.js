const mongoose = require('mongoose');

const dailyRevenueSchema = new mongoose.Schema({
  businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  date:          { type: String, required: true }, // YYYY-MM-DD
  actualRevenue: { type: Number, default: null },  // null = not entered yet
  notes:         { type: String, default: '' },
  // Where the figure came from: typed by hand or imported from the POS closing report
  source:        { type: String, enum: ['manual', 'import'], default: 'manual' },
  importedAt:    { type: Date, default: null },
  // What an import also tells us about the day (null when the report did not have it)
  tickets:       { type: Number, default: null },
  covers:        { type: Number, default: null },
  tips:          { type: Number, default: null },
  byMethod:      { type: { _id: false, cash: Number, card: Number, bizum: Number, other: Number }, default: undefined },
}, { timestamps: true });

// One record per business per day
dailyRevenueSchema.index({ businessId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyRevenue', dailyRevenueSchema);
