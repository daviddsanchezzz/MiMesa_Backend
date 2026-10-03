const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Expense = require('../../modules/finance/models/Expense');
const { syncInvoiceExpense, removeInvoiceExpense, invoiceExpensePayload } = require('../../modules/finance/services/invoiceExpenseSync');

const originalUpdate = Expense.findOneAndUpdate;
const originalDelete = Expense.deleteMany;
afterEach(() => {
  Expense.findOneAndUpdate = originalUpdate;
  Expense.deleteMany = originalDelete;
});

function invoice(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), businessId: new mongoose.Types.ObjectId(), supplierId: new mongoose.Types.ObjectId(),
    invoiceNumber: 'F-1', invoiceDate: '2026-09-30', total: mongoose.Types.Decimal128.fromString('28.05'),
    currency: 'EUR', documentUrl: '/document', status: 'CONFIRMED', createdBy: 'owner', ...overrides,
  };
}

describe('invoice analytical expense sync', () => {
  test('uses one stable upsert key and never treats recognition as a recurring payment', async () => {
    const source = invoice();
    let call;
    Expense.findOneAndUpdate = async (...args) => { call = args; return { _id: 'expense' }; };
    await syncInvoiceExpense(source, { category: 'food' });
    assert.deepEqual(call[0], { businessId: source.businessId, sourceType: 'INVOICE', sourceId: source._id });
    assert.equal(call[1].$set.amount, 28.05);
    assert.equal(call[1].$set.category, 'food');
    assert.equal(call[1].$set.isRecurring, false);
    assert.equal(call[2].upsert, true);
  });

  test('REVIEW and FAILED invoices do not touch Finance', async () => {
    let calls = 0;
    Expense.findOneAndUpdate = async () => { calls += 1; };
    assert.equal(await syncInvoiceExpense(invoice({ status: 'REVIEW' })), null);
    assert.equal(await syncInvoiceExpense(invoice({ status: 'FAILED' })), null);
    assert.equal(calls, 0);
  });

  test('deletion is tenant-scoped and only targets automatic invoice entries', async () => {
    const source = invoice();
    let filter;
    Expense.deleteMany = async (value) => { filter = value; return { deletedCount: 1 }; };
    await removeInvoiceExpense(source);
    assert.equal(filter.businessId, source.businessId);
    assert.equal(filter.sourceType, 'INVOICE');
    assert.deepEqual(filter.$or, [{ sourceId: source._id }, { invoiceId: source._id }]);
  });

  test('requires financial date and amount before confirmation can be recognised', () => {
    assert.throws(() => invoiceExpensePayload(invoice({ total: null }), null), { code: 'INVALID_INVOICE_EXPENSE' });
    assert.throws(() => invoiceExpensePayload(invoice({ invoiceDate: null }), null), { code: 'INVALID_INVOICE_EXPENSE' });
  });
});
