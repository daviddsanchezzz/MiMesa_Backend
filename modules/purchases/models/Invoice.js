const mongoose = require('mongoose');

const decimalField = { type: mongoose.Schema.Types.Decimal128, default: null };
const taxBreakdownSchema = new mongoose.Schema({
  taxRate: decimalField,
  taxableBase: decimalField,
  taxAmount: decimalField,
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null, index: true },
  // A delivery note (albarán) proves what arrived; it is not an expense. Documents saved before this field existed are invoices.
  kind: { type: String, enum: ['INVOICE', 'DELIVERY_NOTE'], default: 'INVOICE' },
  // For a delivery note: the invoice that bills it
  billedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
  invoiceNumber: { type: String, default: null, trim: true },
  invoiceDate: { type: String, default: null },
  grossAmount: decimalField,
  discountRate: decimalField,
  discountAmount: decimalField,
  shippingAmount: decimalField,
  subtotal: decimalField,
  taxAmount: decimalField,
  total: decimalField,
  taxBreakdown: { type: [taxBreakdownSchema], default: [] },
  currency: { type: String, default: 'EUR', uppercase: true, trim: true },
  // Kept separate from status: a confirmed/recognised invoice is not
  // necessarily paid. Payment workflows can extend this later.
  paymentStatus: { type: String, enum: ['UNPAID', 'PAID'], default: 'UNPAID' },
  dueDate: { type: String, default: null },
  documentUrl: { type: String, required: true },
  documentKey: { type: String, required: true, select: false },
  documentMimeType: { type: String, required: true },
  documentOriginalName: { type: String, required: true },
  documentSize: { type: Number, required: true, min: 1 },
  status: {
    type: String,
    enum: ['PROCESSING', 'REVIEW', 'CONFIRMED', 'FAILED'],
    default: 'PROCESSING',
    index: true,
  },
  extractionRaw: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
  extractionWarnings: { type: [String], default: [] },
  extractionError: { type: String, default: null, select: false },
  createdBy: { type: String, default: null },
}, { timestamps: true });

invoiceSchema.index({ businessId: 1, createdAt: -1 });
invoiceSchema.index({ businessId: 1, supplierId: 1, invoiceDate: -1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
