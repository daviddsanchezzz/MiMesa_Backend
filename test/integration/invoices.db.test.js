const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { InvoiceExtractionService } = require('../../modules/purchases/services/invoiceExtractionService');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

const valid = {
  supplier: { name: 'Proveedor Uno', taxId: 'B-12345678' },
  invoiceNumber: 'F-1',
  invoiceDate: '2026-09-30',
  currency: 'EUR',
  items: [
    { description: 'Base reducida', quantity: 2, unitPrice: 10, discount: null, taxRate: 10, total: 20 },
    { description: 'Base general', quantity: 1, unitPrice: 5, discount: null, taxRate: 21, total: 5 },
  ],
  grossAmount: 25,
  discountRate: null,
  discountAmount: null,
  shippingAmount: 0,
  subtotal: 25,
  taxAmount: 3.05,
  total: 28.05,
  taxBreakdown: [
    { taxRate: 10, taxableBase: 20, taxAmount: 2 },
    { taxRate: 21, taxableBase: 5, taxAmount: 1.05 },
  ],
};

describe('invoice extraction API', { skip }, () => {
  let app, mongoose, Business, BusinessMember, Invoice, Supplier, Expense;
  let businessA, businessB, storageDir, firstInvoiceId, extractionBuffers;
  const as = (user, business) => ({ 'x-test-user': user, 'x-business-id': String(business._id) });

  before(async () => {
    storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vetra-invoices-'));
    process.env.INVOICE_STORAGE_PROVIDER = 'local';
    process.env.INVOICE_STORAGE_DIR = storageDir;
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_invoices_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require('../../core/models/Business');
    BusinessMember = require('../../core/models/BusinessMember');
    Invoice = require('../../modules/purchases/models/Invoice');
    Supplier = require('../../modules/purchases/models/Supplier');
    Expense = require('../../modules/finance/models/Expense');

    businessA = await Business.create({ name: 'Restaurante A', email: 'invoice-a@example.test', plan: 'pro', subscriptionStatus: 'active' });
    businessB = await Business.create({ name: 'Salon B', email: 'invoice-b@example.test', plan: 'pro', subscriptionStatus: 'active', businessType: 'appointments' });
    addUser({ id: 'owner-a' });
    addUser({ id: 'owner-b' });
    await BusinessMember.create({ userId: 'owner-a', businessId: businessA._id, role: 'owner' });
    await BusinessMember.create({ userId: 'owner-b', businessId: businessB._id, role: 'owner' });
    await Promise.all([Invoice.init(), Supplier.init(), Expense.init(), require('../../modules/purchases/models/InvoiceItem').init()]);

    const fixtures = {
      'valid.pdf': valid,
      'same-supplier.pdf': { ...valid, invoiceNumber: 'F-2' },
      'partial.pdf': {
        supplier: { name: null, taxId: null }, invoiceNumber: null, invoiceDate: null, currency: null,
        items: [{ description: 'Linea', quantity: null, unitPrice: null, discount: null, taxRate: null, total: null }],
        subtotal: null, taxAmount: null, total: null,
      },
      'invalid-ai.pdf': { ...valid, total: 'not-a-number' },
    };
    extractionBuffers = new Map();
    const provider = {
      extract: async (document) => {
        extractionBuffers.set(document.originalName, document.buffer);
        if (document.originalName === 'provider-fail.pdf') throw new Error('provider unavailable');
        return fixtures[document.originalName] || valid;
      },
    };
    require('../../modules/purchases/controllers/invoiceController')
      .setExtractionServiceForTests(new InvoiceExtractionService(provider));
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
    if (storageDir) await fs.promises.rm(storageDir, { recursive: true, force: true });
    delete process.env.INVOICE_STORAGE_DIR;
    delete process.env.INVOICE_STORAGE_PROVIDER;
  });

  async function upload(name, business = businessA, user = 'owner-a') {
    return request(app).post('/api/invoices/extract').set(as(user, business))
      .attach('file', Buffer.from('%PDF-1.4\nfixture'), { filename: name, contentType: 'application/pdf' });
  }

  test('extracts a valid invoice with multiple VAT rates and creates its supplier', async () => {
    const response = await upload('valid.pdf');
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.status, 'REVIEW');
    firstInvoiceId = response.body._id;
    assert.equal(response.body.items.length, 2);
    assert.deepEqual(response.body.items.map((item) => item.taxRate), [10, 21]);
    assert.equal(response.body.grossAmount, 25);
    assert.deepEqual(response.body.taxBreakdown, [
      { taxRate: 10, taxableBase: 20, taxAmount: 2 },
      { taxRate: 21, taxableBase: 5, taxAmount: 1.05 },
    ]);
    assert.equal(response.body.supplier.taxId, 'B-12345678');
    assert.equal(await Supplier.countDocuments({ businessId: businessA._id }), 1);
    const visibleSuppliers = await request(app).get('/api/suppliers').set(as('owner-a', businessA));
    assert.equal(visibleSuppliers.status, 200);
    assert.ok(visibleSuppliers.body.some((supplier) => supplier._id === response.body.supplierId));
    assert.equal(extractionBuffers.get('valid.pdf').toString(), '%PDF-1.4\nfixture');

    const stored = await Invoice.findById(firstInvoiceId).select('+documentKey').lean();
    assert.equal(stored.documentKey, `${businessA._id}/${firstInvoiceId}/original.pdf`);

    const document = await request(app).get(response.body.documentUrl).set(as('owner-a', businessA));
    assert.equal(document.status, 200);
    assert.match(document.headers['content-type'], /application\/pdf/);
  });

  test('reuses a supplier by normalized tax ID', async () => {
    const response = await upload('same-supplier.pdf');
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(await Supplier.countDocuments({ businessId: businessA._id }), 1);
  });

  test('a human correction updates the existing supplier name located by tax ID', async () => {
    const response = await request(app).patch(`/api/invoices/${firstInvoiceId}`).set(as('owner-a', businessA)).send({
      supplier: { name: 'Proveedor Uno Corregido', taxId: 'B12345678' },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.supplier.name, 'Proveedor Uno Corregido');
    assert.equal(await Supplier.countDocuments({ businessId: businessA._id }), 1);
  });

  test('stores partial extraction with nulls in REVIEW', async () => {
    const response = await upload('partial.pdf');
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.status, 'REVIEW');
    assert.equal(response.body.total, null);
    assert.equal(response.body.items[0].quantity, null);
    assert.equal(await Expense.countDocuments({ businessId: businessA._id, sourceType: 'INVOICE' }), 0);
  });

  test('invalid AI data and provider errors leave FAILED invoices', async () => {
    const invalid = await upload('invalid-ai.pdf');
    assert.equal(invalid.status, 422);
    assert.equal((await Invoice.findById(invalid.body.invoiceId)).status, 'FAILED');
    assert.equal(await Expense.countDocuments({ sourceId: invalid.body.invoiceId }), 0);

    const failure = await upload('provider-fail.pdf');
    assert.equal(failure.status, 502);
    assert.equal((await Invoice.findById(failure.body.invoiceId)).status, 'FAILED');
  });

  test('rejects invalid file content before creating an invoice', async () => {
    const beforeCount = await Invoice.countDocuments({ businessId: businessA._id });
    const response = await request(app).post('/api/invoices/extract').set(as('owner-a', businessA))
      .attach('file', Buffer.from('not really a PDF'), { filename: 'fake.pdf', contentType: 'application/pdf' });
    assert.equal(response.status, 400);
    assert.equal(await Invoice.countDocuments({ businessId: businessA._id }), beforeCount);
  });

  test('isolates tenants, supports correction, and only confirms REVIEW', async () => {
    const created = await upload('tenant-b.pdf', businessB, 'owner-b');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body._id;

    assert.equal((await request(app).get(`/api/invoices/${id}`).set(as('owner-a', businessA))).status, 404);
    assert.equal((await request(app).patch(`/api/invoices/${id}`).set(as('owner-a', businessA)).send({ total: 30 })).status, 404);
    assert.equal((await request(app).get(`/api/invoices/${id}/document`).set(as('owner-a', businessA))).status, 404);

    const patched = await request(app).patch(`/api/invoices/${id}`).set(as('owner-b', businessB)).send({
      invoiceNumber: 'CORREGIDA', total: 30,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.invoiceNumber, 'CORREGIDA');
    assert.equal(patched.body.total, 30);

    const confirmed = await request(app).post(`/api/invoices/${id}/confirm`).set(as('owner-b', businessB));
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, 'CONFIRMED');
    assert.equal((await request(app).post(`/api/invoices/${id}/confirm`).set(as('owner-b', businessB))).status, 200);
    assert.equal(await Expense.countDocuments({ businessId: businessB._id, sourceType: 'INVOICE', sourceId: id }), 1);
    let linked = await Expense.findOne({ businessId: businessB._id, sourceType: 'INVOICE', sourceId: id }).lean();
    assert.equal(linked.amount, 30);
    assert.equal(String(linked.supplierId), String(confirmed.body.supplierId));

    const edited = await request(app).patch(`/api/invoices/${id}`).set(as('owner-b', businessB)).send({ total: 31 });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.total, 31);
    assert.equal(edited.body.status, 'CONFIRMED');
    linked = await Expense.findOne({ businessId: businessB._id, sourceType: 'INVOICE', sourceId: id }).lean();
    assert.equal(linked.amount, 31);
    assert.equal(await Expense.countDocuments({ businessId: businessB._id, sourceType: 'INVOICE', sourceId: id }), 1);
    assert.equal(await Expense.countDocuments({ businessId: businessA._id, sourceId: id }), 0);
  });

  test('confirmed invoices are included in Finance and supplier IDs stay tenant-scoped', async () => {
    const created = await upload('finance-summary.pdf');
    const confirmed = await request(app).post(`/api/invoices/${created.body._id}/confirm`).set(as('owner-a', businessA));
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const dashboard = await request(app).get('/api/revenue/dashboard?from=2026-09-30&to=2026-09-30').set(as('owner-a', businessA));
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    assert.equal(dashboard.body.totalExpenses, 28.05);

    const otherSupplier = await Supplier.create({ businessId: businessB._id, name: 'Solo B', taxId: 'B99999999' });
    const crossTenant = await request(app).post('/api/expenses').set(as('owner-a', businessA)).send({
      supplierId: otherSupplier._id, category: 'other', amount: 10, expenseDate: '2026-09-30',
    });
    assert.equal(crossTenant.status, 400);
  });

  test('deleting an invoice removes only its automatic expense', async () => {
    const created = await upload('delete-linked.pdf');
    const confirmed = await request(app).post(`/api/invoices/${created.body._id}/confirm`).set(as('owner-a', businessA));
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const manual = await Expense.create({
      businessId: businessA._id, supplierId: created.body.supplierId, category: 'other', amount: 9,
      expenseDate: '2026-09-30', notes: 'Manual', sourceType: 'MANUAL',
    });
    const supplierId = created.body.supplierId;
    const response = await request(app).delete(`/api/invoices/${created.body._id}`).set(as('owner-a', businessA));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(await Expense.countDocuments({ sourceType: 'INVOICE', sourceId: created.body._id }), 0);
    assert.ok(await Expense.findById(manual._id));
    assert.ok(await Supplier.findById(supplierId));
  });

  test('returns a short signed URL without allowing another tenant to request it', async () => {
    const storage = require('../../modules/purchases/services/invoiceStorage');
    let accesses = 0;
    storage.setProviderForTests({
      kind: 'supabase',
      async access(key, options) {
        accesses += 1;
        assert.equal(key, `${businessA._id}/${firstInvoiceId}/original.pdf`);
        assert.deepEqual(options, { expiresIn: 60 });
        return { type: 'redirect', url: 'https://storage.example/signed-document', expiresIn: 60 };
      },
    });
    try {
      const denied = await request(app).get(`/api/invoices/${firstInvoiceId}/document`).set(as('owner-b', businessB));
      assert.equal(denied.status, 404);
      assert.equal(accesses, 0);

      const allowed = await request(app).get(`/api/invoices/${firstInvoiceId}/document`).set(as('owner-a', businessA));
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.url, 'https://storage.example/signed-document');
      assert.equal(allowed.body.expiresIn, 60);
      assert.equal(allowed.body.mimeType, 'application/pdf');
      assert.equal(allowed.body.fileName, 'valid.pdf');
      assert.equal(allowed.headers['cache-control'], 'private, no-store');
      assert.equal(accesses, 1);
    } finally {
      storage.resetProviderForTests();
    }
  });

  test('does not call storage for an invoice that does not exist', async () => {
    const storage = require('../../modules/purchases/services/invoiceStorage');
    let accesses = 0;
    storage.setProviderForTests({
      kind: 'supabase',
      async access() { accesses += 1; },
    });
    try {
      const missingId = new mongoose.Types.ObjectId();
      const response = await request(app).get(`/api/invoices/${missingId}/document`).set(as('owner-a', businessA));
      assert.equal(response.status, 404);
      assert.equal(accesses, 0);
    } finally {
      storage.resetProviderForTests();
    }
  });

  test('returns a controlled error when a signed URL cannot be generated', async () => {
    const storage = require('../../modules/purchases/services/invoiceStorage');
    storage.setProviderForTests({
      kind: 'supabase',
      async access() {
        const error = new Error('remote failure');
        error.code = 'SIGNED_URL_FAILED';
        throw error;
      },
    });
    try {
      const response = await request(app).get(`/api/invoices/${firstInvoiceId}/document`).set(as('owner-a', businessA));
      assert.equal(response.status, 502);
      assert.equal(response.body.code, 'DOCUMENT_ACCESS_FAILED');
    } finally {
      storage.resetProviderForTests();
    }
  });

  test('keeps Mongo data when storage deletion fails', async () => {
    const created = await upload('delete-failure.pdf');
    assert.equal(created.status, 201);
    const storage = require('../../modules/purchases/services/invoiceStorage');
    storage.setProviderForTests({
      kind: 'supabase',
      async remove() {
        const error = new Error('remote failure');
        error.code = 'DOCUMENT_DELETE_FAILED';
        throw error;
      },
    });
    try {
      const response = await request(app).delete(`/api/invoices/${created.body._id}`).set(as('owner-a', businessA));
      assert.equal(response.status, 502);
      assert.equal(response.body.code, 'DOCUMENT_DELETE_FAILED');
      assert.ok(await Invoice.findById(created.body._id));
    } finally {
      storage.resetProviderForTests();
    }

    let removedKey;
    storage.setProviderForTests({
      kind: 'supabase',
      async remove(key) { removedKey = key; },
    });
    try {
      const response = await request(app).delete(`/api/invoices/${created.body._id}`).set(as('owner-a', businessA));
      assert.equal(response.status, 200);
      assert.equal(removedKey, `${businessA._id}/${created.body._id}/original.pdf`);
      assert.equal(await Invoice.findById(created.body._id), null);
    } finally {
      storage.resetProviderForTests();
    }
  });
});
