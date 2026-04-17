const mongoose = require('mongoose');

const SUPPLIER_CATEGORIES = ['food', 'beverage', 'cleaning', 'maintenance', 'utilities', 'staff', 'other'];

const supplierSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:        { type: String, required: true, trim: true },
  category:    { type: String, enum: SUPPLIER_CATEGORIES, default: 'other' },
  contactName: { type: String, default: '' },
  phone:       { type: String, default: '' },
  email:       { type: String, default: '' },
  notes:       { type: String, default: '' },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Supplier', supplierSchema);
