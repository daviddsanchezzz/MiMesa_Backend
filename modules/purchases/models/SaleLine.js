const mongoose = require('mongoose');

// What was sold of one dish on one day, as the till reported it (imported from a file, later from an email).
const saleLineSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  date: { type: String, required: true },                                          // YYYY-MM-DD
  key: { type: String, required: true },                                           // the dish: its code or the normalised name
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null }, // the dish of the carta when it is recognised
  externalId: { type: String, default: '' },
  name: { type: String, default: '' },                                             // as the till wrote it
  quantity: { type: Number, required: true },                                      // units sold
  amount: { type: Number, default: null },                                         // € sold, when the file has it
  source: { type: String, enum: ['import', 'email'], default: 'import' },
}, { timestamps: true });

saleLineSchema.index({ businessId: 1, date: 1, key: 1 }, { unique: true });
saleLineSchema.index({ businessId: 1, itemId: 1, date: -1 });

module.exports = mongoose.model('SaleLine', saleLineSchema);
