const mongoose = require('mongoose');

// One purchase of an ingredient: a line of a confirmed invoice, as price per kg / l / unit (VAT excluded).
const ingredientPriceSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', required: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InvoiceItem', required: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  date: { type: String, required: true },                 // YYYY-MM-DD of the invoice
  price: { type: Number, required: true, min: 0 },        // per kg / l / unit
  quantity: { type: Number, default: null },              // how many kg / l / units were bought
  description: { type: String, default: '' },
}, { timestamps: true });

ingredientPriceSchema.index({ businessId: 1, ingredientId: 1, date: -1 });
ingredientPriceSchema.index({ invoiceId: 1 });
ingredientPriceSchema.index({ itemId: 1 }, { unique: true });

module.exports = mongoose.model('IngredientPrice', ingredientPriceSchema);
