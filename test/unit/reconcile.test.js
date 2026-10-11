const test = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('../../modules/purchases/lib/reconcile');

const line = (description, quantity, unitPrice, extra = {}) => ({ description, quantity, unitPrice, discount: null, total: quantity * unitPrice, ...extra });

test('everything matches: no issues', () => {
  const r = reconcile({ invoiceItems: [line('Salmón', 10, 10)], noteItems: [line('SALMON', 10, 10)], invoiceBase: 100, noteTotals: [100] });
  assert.strictEqual(r.issues, 0);
  assert.strictEqual(r.difference, 0);
});

test('linked lines match by ingredient even when the text differs', () => {
  const r = reconcile({ invoiceItems: [line('Salmón noruego', 8, 10, { ingredientId: 'a' })], noteItems: [line('SALM NOR', 10, 10, { ingredientId: 'a' })] });
  assert.strictEqual(r.lines[0].issue, 'less-billed');
});

test('more billed than delivered, price change, not delivered and not billed', () => {
  const r = reconcile({
    invoiceItems: [line('Arroz', 12, 2), line('Aceite', 5, 4.4), line('Vino', 3, 5)],
    noteItems: [line('Arroz', 10, 2), line('Aceite', 5, 4), line('Pan', 2, 1)],
    invoiceBase: 100, noteTotals: [60],
  });
  const by = Object.fromEntries(r.lines.map((l) => [l.name, l.issue]));
  assert.deepStrictEqual(by, { Arroz: 'more-billed', Aceite: 'price', Vino: 'not-delivered', Pan: 'not-billed' });
  assert.strictEqual(r.issues, 4);
  assert.strictEqual(r.difference, 40);
});

test('quantities use the content of the package when linked', () => {
  const r = reconcile({ invoiceItems: [line('Caja 12x1l', 1, 12, { ingredientId: 'x', content: 12 })], noteItems: [line('Aceite 1 l', 12, 1, { ingredientId: 'x', content: 1 })] });
  assert.strictEqual(r.issues, 0);
});

test('a note without totals leaves the difference unknown', () => {
  const r = reconcile({ invoiceItems: [line('A', 1, 1)], noteItems: [line('A', 1, 1)], invoiceBase: 1, noteTotals: [null] });
  assert.strictEqual(r.deliveredBase, null);
  assert.strictEqual(r.difference, null);
});
