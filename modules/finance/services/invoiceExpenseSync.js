const Expense = require('../models/Expense');

function decimalToNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function invoiceExpensePayload(invoice, supplier) {
  const amount = decimalToNumber(invoice.total);
  if (!invoice.invoiceDate || amount === null || amount < 0) {
    const error = new Error('La factura necesita fecha e importe total para reflejarse en Finanzas');
    error.code = 'INVALID_INVOICE_EXPENSE';
    throw error;
  }
  return {
    supplierId: invoice.supplierId || null,
    category: supplier?.category || 'other',
    amount,
    currency: invoice.currency || 'EUR',
    expenseDate: invoice.invoiceDate,
    notes: invoice.invoiceNumber ? `Factura ${invoice.invoiceNumber}` : 'Factura confirmada',
    attachmentUrl: invoice.documentUrl || '',
    isRecurring: false,
    recurringExpenseId: null,
    sourceType: 'INVOICE',
    sourceId: invoice._id,
    invoiceId: invoice._id,
    createdBy: invoice.createdBy || 'system',
  };
}

async function syncInvoiceExpense(invoice, supplier = null) {
  if (invoice.status !== 'CONFIRMED') return null;
  return Expense.findOneAndUpdate(
    { businessId: invoice.businessId, sourceType: 'INVOICE', sourceId: invoice._id },
    { $set: invoiceExpensePayload(invoice, supplier), $setOnInsert: { businessId: invoice.businessId } },
    { upsert: true, new: true, runValidators: true },
  );
}

async function removeInvoiceExpense(invoice) {
  return Expense.deleteMany({
    businessId: invoice.businessId,
    sourceType: 'INVOICE',
    $or: [{ sourceId: invoice._id }, { invoiceId: invoice._id }],
  });
}

module.exports = { syncInvoiceExpense, removeInvoiceExpense, invoiceExpensePayload };
