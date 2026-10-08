const test = require('node:test');
const assert = require('node:assert');
const { lineCost, costOf, marginOf, suggestedPrice } = require('../../modules/purchases/lib/recipeCost');

const ings = new Map([
  ['a', { name: 'Salmón', unit: 'kg', lastPrice: 10, prevPrice: 8 }],
  ['b', { name: 'Arroz', unit: 'kg', lastPrice: 2, prevPrice: 2 }],
  ['c', { name: 'Sin precio', unit: 'kg', lastPrice: null, prevPrice: null }],
]);

test('waste raises the quantity you pay for', () => {
  assert.ok(Math.abs(lineCost({ quantity: 0.18, wastePct: 10 }, ings.get('a')) - 2) < 1e-9);
  assert.strictEqual(lineCost({ quantity: 1 }, ings.get('c')), null);
});

test('cost adds lines and other cost, counts missing prices and keeps the previous cost', () => {
  const c = costOf({ lines: [{ ingredientId: 'a', quantity: 0.2 }, { ingredientId: 'b', quantity: 0.1 }, { ingredientId: 'c', quantity: 1 }], otherCost: 0.5 }, ings);
  assert.strictEqual(c.cost, 2.7);
  assert.strictEqual(c.before, 2.3);
  assert.strictEqual(c.missing, 1);
});

test('margin takes the VAT out of the price', () => {
  assert.deepStrictEqual(marginOf(11, 3, 10), { net: 10, profit: 7, marginPct: 70 });
  assert.strictEqual(marginOf(null, 3, 10).marginPct, null);
});

test('suggested price reaches the target margin, VAT included, up to 10 cents', () => {
  assert.strictEqual(suggestedPrice(3, { targetMarginPct: 70, vatPct: 10 }), 11);
  assert.strictEqual(suggestedPrice(0, {}), null);
});
