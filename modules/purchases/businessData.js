const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');
const Invoice = require('./models/Invoice');
const storage = require('./services/invoiceStorage');

registerBusinessData({
  key: 'purchases',
  erase: async (businessId) => {
    // Purge first: on failure Mongo remains intact and the erasure can be retried safely.
    try {
      await storage.removeBusiness(businessId);
    } catch (error) {
      console.error(`[purchases] business document purge failed business=${businessId} operation=removeBusiness code=${error.code || 'UNKNOWN'}`);
      throw error;
    }
    return deleteAllFor(businessId, {
      InvoiceItem: require('./models/InvoiceItem'),
      Invoice,
      PurchaseOrder: require('./models/PurchaseOrder'),
      PurchaseProduct: require('./models/PurchaseProduct'),
      Supplier: require('./models/Supplier'),
    });
  },
});
