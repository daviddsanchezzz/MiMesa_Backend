const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const translation = require('../../modules/menu/services/translationService');
const { _missingTexts } = require('../../modules/menu/controllers/menuController');

describe('menu translation service', () => {
  let calls;
  beforeEach(() => { calls = []; });
  after(() => translation.setProviderForTests(undefined));

  const fake = (reply) => translation.setProviderForTests({ translate: async (payload) => { calls.push(payload); return reply(payload); } });

  test('returns only what was asked, for known ids and asked languages', async () => {
    fake(() => [
      { id: 'a', lang: 'en', text: ' Ham croquettes ' },
      { id: 'a', lang: 'fr', text: 'Croquettes' },          // not asked
      { id: 'zzz', lang: 'en', text: 'Ghost' },              // not sent
      { id: 'a', lang: 'ca', text: '' },                     // empty
    ]);
    const out = await translation.translate({ from: 'es', items: [{ id: 'a', kind: 'dish', text: 'Croquetas de jamón', targets: ['en', 'ca'] }] });
    assert.deepEqual(out, { a: { en: 'Ham croquettes' } });
  });

  test('skips empty texts and the source language, and sends in chunks', async () => {
    fake((p) => p.items.map((i) => ({ id: i.id, lang: i.targets[0], text: `t-${i.id}` })));
    const items = Array.from({ length: 95 }, (_, i) => ({ id: `i${i}`, kind: 'dish', text: `Plato ${i}`, targets: ['es', 'en'] }));
    items.push({ id: 'empty', kind: 'dish', text: '  ', targets: ['en'] });
    const out = await translation.translate({ from: 'es', items });
    assert.equal(calls.length, Math.ceil(95 / translation.CHUNK));
    assert.equal(Object.keys(out).length, 95);
    assert.deepEqual(out.i0, { en: 't-i0' });
    assert.ok(calls.every((c) => c.items.every((i) => !i.targets.includes('es'))));
  });
});

describe('what is missing a translation', () => {
  const menu = {
    languages: ['es', 'en', 'ca'],
    categories: [{ _id: 'c1', name: { es: 'Entrantes', en: 'Starters' } }],
    items: [
      { _id: 'i1', name: { es: 'Croquetas' }, description: { es: 'Seis unidades', en: 'Six' } },
      { _id: 'i2', name: { es: 'Agua', en: 'Water', ca: 'Aigua' }, description: {} },
    ],
    daily: { title: { es: 'Menú del día' }, includes: {}, courses: [{ name: { es: 'Primeros' }, options: [{ name: { es: 'Lentejas' } }] }] },
  };

  test('lists each text with the languages it lacks, nothing for complete or empty ones', () => {
    const list = _missingTexts(menu);
    const byId = Object.fromEntries(list.map((x) => [x.id, x.targets]));
    assert.deepEqual(byId['cat:c1'], ['ca']);
    assert.deepEqual(byId['dish:i1'], ['en', 'ca']);
    assert.deepEqual(byId['desc:i1'], ['ca']);
    assert.equal(byId['dish:i2'], undefined);
    assert.equal(byId['desc:i2'], undefined);
    assert.deepEqual(byId['daily:title'], ['en', 'ca']);
    assert.equal(byId['daily:includes'], undefined);
    assert.deepEqual(byId['daily:c0'], ['en', 'ca']);
    assert.deepEqual(byId['daily:c0o0'], ['en', 'ca']);
  });

  test('applying a translation targets the right path', () => {
    const list = _missingTexts(menu);
    assert.deepEqual(list.find((x) => x.id === 'daily:c0o0').apply('en', 'Lentils'), { model: 'daily', path: 'courses.0.options.0.name.en', text: 'Lentils' });
    assert.deepEqual(list.find((x) => x.id === 'dish:i1').apply('ca', 'X'), { model: 'item', id: 'i1', path: 'name.ca', text: 'X' });
  });

  test('a single-language menu has nothing to translate', () => {
    assert.equal(_missingTexts({ ...menu, languages: ['es'] }).length, 0);
  });
});
