const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  supplierId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  category:      { type: String, required: true },
  amount:        { type: Number, required: true, min: 0 },
  currency:      { type: String, default: 'EUR' },
  expenseDate:   { type: String, required: true },  // YYYY-MM-DD
  notes:         { type: String, default: '' },
  attachmentUrl: { type: String, default: '' },
  isRecurring:        { type: Boolean, default: false },
  recurringExpenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringExpense', default: null },
  // An invoice entry recognises a cost for analytics; it does not assert that
  // the invoice has been paid from cash or bank.
  sourceType:          { type: String, enum: ['MANUAL', 'RECURRING', 'INVOICE'], default: 'MANUAL', index: true },
  sourceId:            { type: mongoose.Schema.Types.ObjectId, default: null },
  invoiceId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
  createdBy:          { type: String, default: null }, // Better Auth user ID or 'system' for cron
}, { timestamps: true });

expenseSchema.index({ businessId: 1, expenseDate: -1 });
expenseSchema.index({ businessId: 1, supplierId: 1 });
expenseSchema.index(
  { businessId: 1, sourceType: 1, sourceId: 1 },
  { unique: true, partialFilterExpression: { sourceType: 'INVOICE', sourceId: { $type: 'objectId' } } },
);

module.exports = mongoose.model('Expense', expenseSchema);
