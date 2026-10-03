/**
 * Safely links historical confirmed purchase invoices to analytical expenses.
 * Dry-run is the default. Use --apply only after reviewing ambiguous matches.
 *
 *   node scripts/backfillInvoiceExpenses.js
 *   node scripts/backfillInvoiceExpenses.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Invoice = require('../modules/purchases/models/Invoice');
const Expense = require('../modules/finance/models/Expense');
const Supplier = require('../modules/purchases/models/Supplier');
const { syncInvoiceExpense } = require('../modules/finance/services/invoiceExpenseSync');

async function run() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);

  // There is already one Supplier collection. Audit identity collisions before
  // backfilling normalised keys; never merge an ambiguous group automatically.
  const suppliers = await Supplier.find({}).select('+normalizedName +normalizedTaxId').lean();
  const groupBy = (keyFor) => {
    const groups = new Map();
    for (const supplier of suppliers) {
      const value = keyFor(supplier);
      if (!value) continue;
      const key = `${supplier.businessId}:${value}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(supplier);
    }
    return groups;
  };
  const taxGroups = groupBy((supplier) => Supplier.normalizeTaxId(supplier.taxId));
  const nameGroups = groupBy((supplier) => Supplier.normalizeSupplierName(supplier.name));
  const duplicateTaxes = [...taxGroups.entries()].filter(([, rows]) => rows.length > 1);
  const duplicateNames = [...nameGroups.entries()].filter(([, rows]) => rows.length > 1);
  for (const [key, rows] of [...duplicateTaxes, ...duplicateNames]) {
    console.warn(`SUPPLIER REVIEW key=${key} ids=${rows.map((row) => row._id).join(',')}`);
  }
  let supplierIdentitiesUpdated = 0;
  if (apply) {
    for (const supplier of suppliers) {
      const normalizedTaxId = Supplier.normalizeTaxId(supplier.taxId) || null;
      const normalizedName = Supplier.normalizeSupplierName(supplier.name);
      const taxKey = normalizedTaxId ? `${supplier.businessId}:${normalizedTaxId}` : null;
      if (taxKey && (taxGroups.get(taxKey)?.length || 0) > 1) continue;
      if (supplier.normalizedTaxId === normalizedTaxId && supplier.normalizedName === normalizedName) continue;
      await Supplier.collection.updateOne({ _id: supplier._id }, { $set: { normalizedTaxId, normalizedName } });
      supplierIdentitiesUpdated += 1;
    }
  }

  const invoices = await Invoice.find({ status: 'CONFIRMED' }).cursor();
  const summary = { inspected: 0, existing: 0, wouldCreate: 0, created: 0, ambiguous: 0, invalid: 0 };
  for await (const invoice of invoices) {
    summary.inspected += 1;
    const existing = await Expense.exists({
      businessId: invoice.businessId,
      sourceType: 'INVOICE',
      sourceId: invoice._id,
    });
    if (existing) { summary.existing += 1; continue; }

    const amount = invoice.total == null ? null : Number(invoice.total.toString());
    if (!invoice.invoiceDate || !Number.isFinite(amount)) {
      summary.invalid += 1;
      console.warn(`INVALID invoice=${invoice._id} business=${invoice.businessId}`);
      continue;
    }
    const possibleManual = await Expense.find({
      businessId: invoice.businessId,
      sourceType: { $in: [null, 'MANUAL'] },
      supplierId: invoice.supplierId || null,
      expenseDate: invoice.invoiceDate,
      amount,
    }).select('_id').lean();
    if (possibleManual.length) {
      summary.ambiguous += 1;
      console.warn(`AMBIGUOUS invoice=${invoice._id} possibleExpenses=${possibleManual.map((x) => x._id).join(',')}`);
      continue;
    }

    summary.wouldCreate += 1;
    if (apply) {
      const supplier = invoice.supplierId
        ? await Supplier.findOne({ _id: invoice.supplierId, businessId: invoice.businessId }).lean()
        : null;
      await syncInvoiceExpense(invoice, supplier);
      summary.created += 1;
      console.log(`LINKED invoice=${invoice._id} business=${invoice.businessId}`);
    }
  }
  if (apply) await Expense.createIndexes();

  console.log(JSON.stringify({
    ...summary,
    supplierIdentitiesUpdated,
    supplierTaxGroupsForManualReview: duplicateTaxes.length,
    supplierNameGroupsForManualReview: duplicateNames.length,
  }, null, 2));
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
