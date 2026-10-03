const mongoose = require('mongoose');

const decimalField = { type: mongoose.Schema.Types.Decimal128, default: null };

const invoiceItemSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
  description: { type: String, required: true, trim: true },
  quantity: decimalField,
  unitPrice: decimalField,
  discount: decimalField,
  taxRate: decimalField,
  total: decimalField,
  position: { type: Number, required: true, min: 0 },
}, { timestamps: true });

invoiceItemSchema.index({ invoiceId: 1, position: 1 }, { unique: true });
invoiceItemSchema.index({ businessId: 1, invoiceId: 1 });

module.exports = mongoose.model('InvoiceItem', invoiceItemSchema);
