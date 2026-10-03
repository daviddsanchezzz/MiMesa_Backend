const mongoose = require('mongoose');

function normalizeTaxId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeSupplierName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

const supplierSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name:        { type: String, required: true, trim: true },
  normalizedName: { type: String, default: '', select: false },
  taxId:       { type: String, default: null, trim: true },
  normalizedTaxId: { type: String, default: null, select: false },
  category:    { type: String, default: 'other' },
  contactName: { type: String, default: '' },
  phone:       { type: String, default: '' },
  whatsappPhone: { type: String, default: '' },
  email:       { type: String, default: '' },
  notes:       { type: String, default: '' },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

supplierSchema.pre('validate', function normalizeIdentity() {
  this.normalizedName = normalizeSupplierName(this.name);
  const normalizedTaxId = normalizeTaxId(this.taxId);
  this.taxId = String(this.taxId || '').trim() || null;
  this.normalizedTaxId = normalizedTaxId || null;
});

supplierSchema.index(
  { businessId: 1, normalizedTaxId: 1 },
  { unique: true, partialFilterExpression: { normalizedTaxId: { $type: 'string' } } },
);
supplierSchema.index({ businessId: 1, normalizedName: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);
module.exports.normalizeTaxId = normalizeTaxId;
module.exports.normalizeSupplierName = normalizeSupplierName;
