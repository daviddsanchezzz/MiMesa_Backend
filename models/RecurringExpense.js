const mongoose = require('mongoose');

const EXPENSE_CATEGORIES = [
  'food', 'beverage', 'cleaning', 'supplies',
  'maintenance', 'marketing', 'rent', 'utilities', 'staff', 'other',
];

const recurringExpenseSchema = new mongoose.Schema({
  businessId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  supplierId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
  category:    { type: String, enum: EXPENSE_CATEGORIES, required: true },
  amount:      { type: Number, required: true, min: 0 },
  currency:    { type: String, default: 'EUR' },
  dayOfMonth:  { type: Number, required: true, min: 1, max: 31 }, // which day of month to generate
  notes:       { type: String, default: '' },
  isActive:    { type: Boolean, default: true },
  createdBy:   { type: String, default: null }, // Better Auth user ID
}, { timestamps: true });

module.exports = mongoose.model('RecurringExpense', recurringExpenseSchema);
