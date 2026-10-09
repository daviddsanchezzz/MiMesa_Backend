const mongoose = require('mongoose');

// A count of the stock on a day: how much of each ingredient there was on the shelves.
const stockCountSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  date: { type: String, required: true },   // YYYY-MM-DD
  lines: { type: [new mongoose.Schema({ ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true }, quantity: { type: Number, required: true, min: 0 } }, { _id: false })], default: [] },
  note: { type: String, default: '', maxlength: 300 },
}, { timestamps: true });

stockCountSchema.index({ businessId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('StockCount', stockCountSchema);
