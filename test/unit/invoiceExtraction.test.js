const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { InvoiceExtractionService } = require('../../modules/purchases/services/invoiceExtractionService');

const base = {
  supplier: { name: 'Distribuciones Norte, S.L.', taxId: 'B-12345678' },
  invoiceNumber: 'F-2026-42',
  invoiceDate: '2026-09-30',
  currency: 'eur',
  items: [
    { description: 'Cafe', quantity: 2, unitPrice: 10, discount: null, taxRate: 10, total: 20 },
    { description: 'Servicio', quantity: 1, unitPrice: 5, discount: 0, taxRate: 21, total: 5 },
  ],
  subtotal: 25,
  taxAmount: 3.05,
  total: 28.05,
};

function serviceReturning(value) {
  return new InvoiceExtractionService({ extract: async () => value });
}

describe('InvoiceExtractionService', () => {
  test('accepts a complete invoice and preserves different VAT rates', async () => {
    const result = await serviceReturning(base).extract({});
    assert.equal(result.data.currency, 'EUR');
    assert.deepEqual(result.data.items.map((item) => item.taxRate), [10, 21]);
    assert.equal(result.data.total, 28.05);
    assert.deepEqual(result.warnings, []);
  });

  test('accepts partial extraction with explicit nulls', async () => {
    const result = await serviceReturning({
      supplier: { name: null, taxId: null },
      invoiceNumber: null,
      invoiceDate: null,
      currency: null,
      items: [{ description: 'Concepto legible', quantity: null, unitPrice: null, discount: null, taxRate: null, total: null }],
      subtotal: null,
      taxAmount: null,
      total: null,
    }).extract({});
    assert.equal(result.data.supplier.name, null);
    assert.equal(result.data.items[0].quantity, null);
    assert.deepEqual(result.warnings, []);
  });

  test('keeps discrepancies for human review and adds warnings', async () => {
    const result = await serviceReturning({ ...base, subtotal: 99, total: 150 }).extract({});
    assert.equal(result.data.subtotal, 99);
    assert.equal(result.warnings.length, 2);
  });

  test('understands invoice-level discounts and reports an inconsistent printed taxable base precisely', async () => {
    const result = await serviceReturning({
      ...base,
      items: [
        { description: 'Base reducida', packageQuantity: 1, quantity: 1, unitPrice: 1054.8, discount: null, taxRate: 10, total: 1054.8 },
        { description: 'Base general', packageQuantity: 0.5, quantity: 1, unitPrice: 19.5, discount: null, taxRate: 21, total: 19.5 },
      ],
      grossAmount: 1074.3,
      discountRate: 7,
      discountAmount: 75.2,
      shippingAmount: 0,
      subtotal: 923.9,
      taxAmount: 101.91,
      total: 1101.01,
      taxBreakdown: [
        { taxRate: 10, taxableBase: 980.96, taxAmount: 98.1 },
        { taxRate: 21, taxableBase: 18.14, taxAmount: 3.81 },
      ],
    }).extract({});

    assert.equal(result.data.items[0].packageQuantity, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /diferencia coincide con el descuento global/);
  });

  test('rejects invalid AI types and impossible dates', async () => {
    await assert.rejects(
      serviceReturning({ ...base, total: '28.05' }).extract({}),
      /total no es un numero valido/,
    );
    await assert.rejects(
      serviceReturning({ ...base, invoiceDate: '2026-02-31' }).extract({}),
      /invoiceDate no es una fecha valida/,
    );
  });

  test('propagates provider failures', async () => {
    const service = new InvoiceExtractionService({ extract: async () => { throw new Error('provider down'); } });
    await assert.rejects(service.extract({}), /provider down/);
  });
});
