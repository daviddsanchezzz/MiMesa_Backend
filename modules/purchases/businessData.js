const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');
const Invoice = require('./models/Invoice');
const storage = require('./services/invoiceStorage');

registerBusinessData({
  key: 'purchases',
  erase: async (businessId) => {
    // Purge first: on failure Mongo remains intact and the erasure can be retried safely.
    await storage.removeBusiness(businessId);
    return deleteAllFor(businessId, {
      InvoiceItem: require('./models/InvoiceItem'),
      Invoice,
      PurchaseOrder: require('./models/PurchaseOrder'),
      PurchaseProduct: require('./models/PurchaseProduct'),
      Supplier: require('./models/Supplier'),
    });
  },
});
