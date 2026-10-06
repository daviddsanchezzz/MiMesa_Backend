const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRows, planImport } = require('../../modules/menu/lib/menuImport');
const v = require('../../modules/menu/lib/validation');
const plans = require('../../core/lib/planCapabilities');

describe('menuImport.normalizeRows', () => {
  test('keeps valid rows, defaults the category and reports the rest', () => {
    const { rows, errors } = normalizeRows([
      { externalId: '12', category: 'Entrantes', name: ' Croquetas ', price: '8.5' },
      { name: 'Agua', price: 2 },
      { category: 'Postres', name: '', price: 5 },
      { category: 'Postres', name: 'Flan', price: -1 },
      { externalId: '12', category: 'Entrantes', name: 'Croquetas', price: 8.5 },
    ]);
    assert.deepEqual(rows.map((r) => [r.name, r.category, r.price]), [['Croquetas', 'Entrantes', 8.5], ['Agua', 'Sin categoría', 2]]);
    assert.deepEqual(errors.map((e) => e.line), [3, 4, 5]);
  });

  test('empty or oversized input', () => {
    assert.equal(normalizeRows([]).rows.length, 0);
    assert.equal(normalizeRows(Array.from({ length: 1501 }, (_, i) => ({ name: `p${i}` }))).rows.length, 0);
  });
});

describe('menuImport.planImport', () => {
  const categories = [{ _id: 'c1', name: { es: 'Entrantes', en: 'Starters' } }];
  const items = [
    { _id: 'i1', categoryId: 'c1', name: { es: 'Croquetas' }, price: 8, priceSource: 'tpv', externalId: '12' },
    { _id: 'i2', categoryId: 'c1', name: { es: 'Ensalada' }, price: 9, priceSource: 'manual', externalId: '' },
    { _id: 'i3', categoryId: 'c1', name: { es: 'Gazpacho' }, price: 6, priceSource: 'tpv', externalId: '99' },
    { _id: 'i4', categoryId: 'c1', name: { es: 'Tortilla' }, price: 7, priceSource: 'tpv', externalId: '55', retired: true },
  ];
  const run = (rows) => planImport(rows, { categories, items, language: 'es' });

  test('new, price change, same, and a manual dish matched by name is linked to the TPV', () => {
    const { plan } = run([
      { externalId: '12', category: 'Entrantes', name: 'Croquetas', price: 9 },   // price changed
      { externalId: '', category: 'entrántes', name: 'ensalada', price: 9 },        // manual → link
      { externalId: '70', category: 'Postres', name: 'Flan', price: 4 },            // new, in a new category
      { externalId: '55', category: 'Entrantes', name: 'Tortilla', price: 7 },      // back from retired
    ]);
    assert.deepEqual(plan.map((p) => p.status), ['price', 'link', 'new', 'same']);
    assert.equal(plan[0].previous, 8);
    assert.equal(plan[2].categoryNew, true);
    assert.equal(plan[3].restore, true);
  });

  test('TPV dishes that no longer appear are reported as missing (retired ones are not)', () => {
    const { missing } = run([{ externalId: '12', category: 'Entrantes', name: 'Croquetas', price: 8 }]);
    assert.deepEqual(missing.map((m) => m.name), ['Gazpacho']);
  });
});

describe('menu validation', () => {
  test('texts keep only the languages in use and require the main one', () => {
    assert.deepEqual(v.texts({ es: ' Hola ', en: 'Hi', fr: 'Salut' }, ['es', 'en'], { label: 'X', max: 10, required: true }), { es: 'Hola', en: 'Hi' });
    assert.throws(() => v.texts({ en: 'Hi' }, ['es', 'en'], { label: 'X', max: 10, required: true }), /obligatorio/);
    assert.throws(() => v.texts({ es: 'demasiado largo' }, ['es'], { label: 'X', max: 5 }), /largo/);
  });

  test('languages, price, allergens and tags', () => {
    assert.deepEqual(v.languages(['es', 'EN', 'es']), ['es', 'en']);
    assert.throws(() => v.languages([]));
    assert.throws(() => v.languages(['espanol']));
    assert.equal(v.price('12,5'.replace(',', '.')), 12.5);
    assert.equal(v.price(''), null);
    assert.throws(() => v.price(-1));
    assert.deepEqual(v.allergens(['gluten', 'huevos']), ['gluten', 'huevos']);
    assert.throws(() => v.allergens(['piedras']));
    assert.throws(() => v.tags(['mágico']));
  });
});

describe('menu module access', () => {
  const biz = (businessType, plan = 'free') => ({ plan, subscriptionStatus: plan === 'free' ? null : 'active', legacyAccess: plan === 'free', businessType });
  test('on for restaurants on every plan, off for appointment businesses unless enabled', () => {
    assert.equal(plans.canUseModule(biz('restaurant'), 'menu'), true);
    assert.equal(plans.canUseModule(biz('restaurant', 'pro'), 'menu'), true);
    assert.equal(plans.canUseModule(biz('appointments'), 'menu'), false);
    assert.equal(plans.canUseModule({ ...biz('appointments'), moduleOverrides: { menu: { enabled: true } } }, 'menu'), true);
  });
});
