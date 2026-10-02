const mongoose = require('mongoose');

/**
 * End-of-day till close: what the app expected by payment method, the cash
 * actually counted and the difference. One per business and day.
 */
const cashCloseSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  date:       { type: String, required: true },  // YYYY-MM-DD, business local
  totals: {
    cash: { type: Number, default: 0 }, card: { type: Number, default: 0 },
    bizum: { type: Number, default: 0 }, other: { type: Number, default: 0 },
    services: { type: Number, default: 0 }, extras: { type: Number, default: 0 },
    discount: { type: Number, default: 0 }, tips: { type: Number, default: 0 },
    total: { type: Number, default: 0 }, payments: { type: Number, default: 0 },
  },
  countedCash: { type: Number, default: null },   // cents counted in the drawer
  difference:  { type: Number, default: null },   // counted - expected cash (with tips paid in cash)
  note:        { type: String, default: '', maxlength: 500 },
  closedBy:    { type: String, default: null },
}, { timestamps: true });

cashCloseSchema.index({ businessId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('BookingCashClose', cashCloseSchema);
