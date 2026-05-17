const mongoose = require('mongoose');

const purchaseOrderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseProduct', required: true },
  productName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0.0001 },
  unit: { type: String, default: '' },
  unitCost: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
}, { _id: false });

const purchaseOrderSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
  supplierName: { type: String, required: true },
  orderDate: { type: Date, required: true },
  status: { type: String, enum: ['draft', 'sent', 'confirmed', 'received', 'cancelled'], default: 'draft' },
  sendMethod: { type: String, enum: ['manual_whatsapp'], default: null },
  sentAt: { type: Date, default: null },
  whatsappMessageSnapshot: { type: String, default: '' },
  notes: { type: String, default: '' },
  items: { type: [purchaseOrderItemSchema], default: [] },
  totalAmount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

purchaseOrderSchema.index({ businessId: 1, orderDate: -1 });
purchaseOrderSchema.index({ businessId: 1, supplierId: 1, orderDate: -1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);

