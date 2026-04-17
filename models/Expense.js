const mongoose = require('mongoose');

const EXPENSE_CATEGORIES = [
  'food', 'beverage', 'cleaning', 'supplies',
  'maintenance', 'marketing', 'rent', 'utilities', 'staff', 'other',
];

const expenseSchema = new mongoose.Schema({
  businessId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  supplierId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  category:      { type: String, enum: EXPENSE_CATEGORIES, required: true },
  amount:        { type: Number, required: true, min: 0 },
  currency:      { type: String, default: 'EUR' },
  expenseDate:   { type: String, required: true },  // YYYY-MM-DD
  notes:         { type: String, default: '' },
  attachmentUrl: { type: String, default: '' },
  isRecurring:   { type: Boolean, default: false },
  createdBy:     { type: String, default: null },   // Better Auth user ID
}, { timestamps: true });

expenseSchema.index({ businessId: 1, expenseDate: -1 });
expenseSchema.index({ businessId: 1, supplierId: 1 });

module.exports = mongoose.model('Expense', expenseSchema);
