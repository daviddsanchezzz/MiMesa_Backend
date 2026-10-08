const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { lineKey, suggestFromDescription } = require('../../modules/purchases/lib/ingredientParse');
const { pricePerUnit } = require('../../modules/purchases/services/ingredientSync');

describe('invoice line → ingredient suggestion', () => {
  test('the same line gives the same key whatever the case, accents or punctuation', () => {
    assert.equal(lineKey('  SALMÓN fresco, 3 KG. '), lineKey('salmon fresco 3 kg'));
    assert.notEqual(lineKey('Limón 1kg'), lineKey('Limón 5kg'));
  });

  test('sizes, packs and counts', () => {
    assert.deepEqual(suggestFromDescription('LIMON BANDEJA 1KG'), { name: 'Limon', unit: 'kg', content: 1 });
    assert.deepEqual(suggestFromDescription('Aceite oliva virgen 5L'), { name: 'Aceite oliva virgen', unit: 'l', content: 5 });
    assert.deepEqual(suggestFromDescription('Nata 500 ml'), { name: 'Nata', unit: 'l', content: 0.5 });
    assert.deepEqual(suggestFromDescription('Harina 25kg saco'), { name: 'Harina', unit: 'kg', content: 25 });
    assert.equal(suggestFromDescription('Cerveza 24x33cl').content, 7.92);
    assert.deepEqual(suggestFromDescription('Huevos M x30'), { name: 'Huevos m', unit: 'ud', content: 30 });
    // No size: billed by weight
    assert.deepEqual(suggestFromDescription('Tomate pera'), { name: 'Tomate pera', unit: 'kg', content: 1 });
    assert.deepEqual(suggestFromDescription('Gambas 250 g'), { name: 'Gambas', unit: 'kg', content: 0.25 });
  });
});

describe('price per kg / l / unit of a line', () => {
  const item = (o) => ({ unitPrice: '12.00', discount: null, content: 5, ...o });
  test('unit price over what the unit holds, with the line discount', () => {
    assert.equal(pricePerUnit(item({})), 2.4);
    assert.equal(pricePerUnit(item({ discount: '10' })), 2.16);
    assert.equal(pricePerUnit(item({ content: 1 })), 12);
  });
  test('no usable price → none', () => {
    assert.equal(pricePerUnit(item({ unitPrice: null })), null);
    assert.equal(pricePerUnit(item({ content: null })), null);
    assert.equal(pricePerUnit(item({ content: 0 })), null);
  });
});

describe('ingredient stats from its purchases', () => {
  const IngredientPrice = require('../../modules/purchases/models/IngredientPrice');
  const Ingredient = require('../../modules/purchases/models/Ingredient');
  const { recomputeIngredient } = require('../../modules/purchases/services/ingredientSync');
  const originals = { find: IngredientPrice.find, updateOne: Ingredient.updateOne };

  async function statsFor(prices) {
    let saved;
    IngredientPrice.find = () => ({ sort: () => ({ lean: async () => prices }) });
    Ingredient.updateOne = async (_f, update) => { saved = update.$set.stats; };
    try { await recomputeIngredient('b', 'i'); } finally { Object.assign(IngredientPrice, { find: originals.find }); Object.assign(Ingredient, { updateOne: originals.updateOne }); }
    return saved;
  }

  test('last, previous purchase on another invoice, change, lowest and highest', async () => {
    const s = await statsFor([
      { price: 10.92, date: '2026-10-05', invoiceId: 'c', supplierId: 's1' },
      { price: 10.92, date: '2026-10-05', invoiceId: 'c', supplierId: 's1' },   // same invoice twice: not the "previous"
      { price: 9.75, date: '2026-09-20', invoiceId: 'b', supplierId: 's1' },
      { price: 9, date: '2026-08-01', invoiceId: 'a', supplierId: 's2' },
    ]);
    assert.equal(s.lastPrice, 10.92);
    assert.equal(s.prevPrice, 9.75);
    assert.equal(s.changePct, 12);
    assert.equal(s.minPrice, 9);
    assert.equal(s.maxPrice, 10.92);
    assert.equal(s.count, 4);
  });

  test('one purchase has no change; none leaves it empty', async () => {
    const one = await statsFor([{ price: 3, date: '2026-10-01', invoiceId: 'a' }]);
    assert.equal(one.changePct, null);
    assert.equal(one.lastPrice, 3);
    const none = await statsFor([]);
    assert.equal(none.lastPrice, null);
    assert.equal(none.count, 0);
  });
});
