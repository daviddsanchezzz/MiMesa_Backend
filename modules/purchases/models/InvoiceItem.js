const mongoose = require('mongoose');

const decimalField = { type: mongoose.Schema.Types.Decimal128, default: null };

const invoiceItemSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
  description: { type: String, required: true, trim: true },
  packageQuantity: decimalField,
  quantity: decimalField,
  unitPrice: decimalField,
  discount: decimalField,
  taxRate: decimalField,
  total: decimalField,
  // The ingredient this line is, and how many of its unit (kg, l, ud) one purchased unit holds
  ingredientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingredient', default: null, index: true },
  content: { type: Number, default: null },
  position: { type: Number, required: true, min: 0 },
}, { timestamps: true });

invoiceItemSchema.index({ invoiceId: 1, position: 1 }, { unique: true });
invoiceItemSchema.index({ businessId: 1, invoiceId: 1 });

module.exports = mongoose.model('InvoiceItem', invoiceItemSchema);
