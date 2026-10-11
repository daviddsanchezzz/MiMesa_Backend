const mongoose = require('mongoose');

// "Limones", "Aceite de oliva": what the restaurant buys, in the unit it is costed in (kg, l or ud).
// The lines of the invoices are linked to it; aliases remember how each line is written and how much of the
// unit one purchased unit holds, so the next invoice links itself.
const aliasSchema = new mongoose.Schema({
  key: { type: String, required: true },                       // lineKey of the invoice line
  label: { type: String, default: '' },                        // how it was written
  content: { type: Number, required: true, min: 0.0001 },     // units of the ingredient in one purchased unit
}, { _id: false });

const ingredientSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  nameKey: { type: String, required: true },
  unit: { type: String, enum: ['kg', 'l', 'ud'], default: 'kg' },
  aliases: { type: [aliasSchema], default: [] },
  // Kept up to date from the prices (see services/ingredientSync): what lists and alerts read
  stats: {
    lastPrice: { type: Number, default: null },
    lastDate: { type: String, default: null },
    lastSupplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    prevPrice: { type: Number, default: null },
    prevDate: { type: String, default: null },
    changePct: { type: Number, default: null },
    minPrice: { type: Number, default: null },
    maxPrice: { type: Number, default: null },
    count: { type: Number, default: 0 },
  },
}, { timestamps: true });

ingredientSchema.index({ businessId: 1, nameKey: 1 }, { unique: true });
ingredientSchema.index({ businessId: 1, 'aliases.key': 1 });

module.exports = mongoose.model('Ingredient', ingredientSchema);
