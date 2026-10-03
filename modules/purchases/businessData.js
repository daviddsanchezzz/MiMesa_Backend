const { registerBusinessData, deleteAllFor } = require('../../core/lib/businessData');
const Invoice = require('./models/Invoice');
const storage = require('./services/invoiceStorage');

registerBusinessData({
  key: 'purchases',
  erase: async (businessId) => {
    const invoices = await Invoice.find({ businessId }).select('+documentKey').lean();
    await Promise.all(invoices.map((invoice) => storage.remove(invoice.documentKey).catch((err) => {
      console.error(`[purchases] failed to erase document invoice=${invoice._id}:`, err.message);
    })));
    return deleteAllFor(businessId, {
      InvoiceItem: require('./models/InvoiceItem'),
      Invoice,
      PurchaseOrder: require('./models/PurchaseOrder'),
      PurchaseProduct: require('./models/PurchaseProduct'),
      Supplier: require('./models/Supplier'),
    });
  },
});
