const mongoose = require('mongoose');

const businessCategorySchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  value:      { type: String, required: true },   // slug stored in Expense.category / Supplier.category
  label:      { type: String, required: true },
  color:      { type: String, default: 'slate' }, // key into the frontend COLOR_DOT map
  isDefault:  { type: Boolean, default: false },
  order:      { type: Number, default: 0 },
}, { timestamps: true });

businessCategorySchema.index({ businessId: 1, value: 1 }, { unique: true });

module.exports = mongoose.model('BusinessCategory', businessCategorySchema);
