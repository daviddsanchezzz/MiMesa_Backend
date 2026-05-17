const mongoose = require('mongoose');

const purchaseProductSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
  name: { type: String, required: true, trim: true },
  unit: { type: String, default: '' },
  defaultUnitCost: { type: Number, default: 0, min: 0 },
  sku: { type: String, default: '', trim: true },
  notes: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

purchaseProductSchema.index({ businessId: 1, supplierId: 1, name: 1 });

module.exports = mongoose.model('PurchaseProduct', purchaseProductSchema);
