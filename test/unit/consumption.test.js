const test = require('node:test');
const assert = require('node:assert');
const { theoreticalUse, reconcile } = require('../../modules/purchases/lib/consumption');
const { normalizeSales } = require('../../modules/purchases/lib/salesRows');

const recipes = [
  { itemId: 'burger', lines: [{ ingredientId: 'beef', quantity: 0.18, wastePct: 10 }, { ingredientId: 'bun', quantity: 1, wastePct: 0 }] },
  { itemId: 'empty', lines: [] },
];

test('theoretical use: units sold × recipe, with the waste of preparing', () => {
  const t = theoreticalUse([{ itemId: 'burger', quantity: 10, key: 'a', name: 'Burger' }, { itemId: 'burger', quantity: 5, key: 'a', name: 'Burger' }], recipes);
  assert.ok(Math.abs(t.use.get('beef') - 3) < 1e-9);   // 15 × 0.18 / 0.9
  assert.strictEqual(t.use.get('bun'), 15);
  assert.strictEqual(t.units, 15);
  assert.strictEqual(t.covered, 15);
});

test('dishes without a recipe or without a match are listed, not counted', () => {
  const t = theoreticalUse([{ itemId: 'empty', quantity: 4, key: 'e', name: 'Plato vacío' }, { itemId: null, quantity: 6, key: 'x', name: 'Sin vincular' }, { itemId: 'burger', quantity: 1, key: 'a', name: 'Burger' }], recipes);
  assert.strictEqual(t.covered, 1);
  assert.deepStrictEqual(t.uncovered.map((u) => [u.name, u.units, u.matched]), [['Sin vincular', 6, false], ['Plato vacío', 4, true]]);
});

const ings = new Map([['beef', { name: 'Ternera', unit: 'kg', lastPrice: 10 }], ['bun', { name: 'Pan', unit: 'ud', lastPrice: 0.5 }]]);

test('without counts: bought minus what the sales and the waste explain', () => {
  const rows = reconcile({ theoretical: new Map([['beef', 3]]), purchased: new Map([['beef', 5]]), wasted: new Map([['beef', 0.5]]), ingredients: ings });
  assert.strictEqual(rows[0].difference, 1.5);
  assert.strictEqual(rows[0].value, 15);
  assert.strictEqual(rows[0].counted, false);
});

test('with two counts: real use = opening + bought − closing', () => {
  const rows = reconcile({ theoretical: new Map([['beef', 3]]), purchased: new Map([['beef', 5]]), wasted: new Map(), opening: new Map([['beef', 2]]), closing: new Map([['beef', 3]]), ingredients: ings });
  assert.strictEqual(rows[0].difference, 1);   // used 4, explained 3
  assert.strictEqual(rows[0].counted, true);
});

test('rows are sorted by the value of the difference', () => {
  const rows = reconcile({ theoretical: new Map([['beef', 1], ['bun', 1]]), purchased: new Map([['beef', 1.2], ['bun', 50]]), wasted: new Map(), ingredients: ings });
  assert.deepStrictEqual(rows.map((r) => r.ingredientId), ['bun', 'beef']);
});

test('sales rows: same dish and day add up, bad rows are reported, returns are skipped', () => {
  const r = normalizeSales([
    { date: '2026-10-05', name: 'Croquetas', quantity: 3, amount: 25.5 },
    { date: '2026-10-05', name: 'CROQUETAS ', quantity: 2, amount: 17 },
    { date: '2026-10-05', name: 'Devolución', quantity: -1 },
    { date: 'mal', name: 'X', quantity: 1 },
    { date: '2026-10-05', externalId: '77', quantity: 4 },
  ]);
  assert.strictEqual(r.rows.length, 2);
  assert.deepStrictEqual(r.rows.find((x) => x.name.startsWith('Croq')).quantity, 5);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.errors.length, 1);
});
