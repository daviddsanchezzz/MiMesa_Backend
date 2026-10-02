const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT } = require('../helpers/load');
const { slugify, normalizeSlugInput, isReserved, SlugError } = require(path.join(ROOT, 'core/lib/slugs'));

test('slugify turns a business name into a clean address', () => {
  assert.equal(slugify('Estética Són'), 'estetica-son');
  assert.equal(slugify('  Peluquería   Marta & Co. '), 'peluqueria-marta-y-co');
  assert.equal(slugify('Café L\'Àvia'), 'cafe-l-avia');
  assert.equal(slugify('Ñandú Bar'), 'nandu-bar');
  assert.equal(slugify('AB'), 'ab-reservas');
  assert.equal(slugify('!!!'), 'mi-negocio');
  const long = slugify('Centro de estética y bienestar integral para toda la familia en Mataró');
  assert.ok(long.length <= 50 && !long.endsWith('-'), long);
});

test('user input is normalized and validated', () => {
  assert.equal(normalizeSlugInput('  Estetica-Son '), 'estetica-son');
  for (const bad of ['ab', '-hola', 'hola-', 'ho--la', 'con espacio', 'tildé', 'a'.repeat(51), '']) {
    assert.throws(() => normalizeSlugInput(bad), SlugError, bad);
  }
  assert.ok(isReserved('contact') && isReserved('api') && isReserved('precios'));
  assert.throws(() => normalizeSlugInput('login'), (e) => e.code === 'SLUG_RESERVED');
});
