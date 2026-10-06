const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dailyIsOn, pick } = require('../../modules/menu/controllers/publicMenuController');
const photos = require('../../modules/menu/services/photoStorage');
const v = require('../../modules/menu/lib/validation');

describe('public menu helpers', () => {
  test('a text falls back to the main language, then to any', () => {
    assert.equal(pick({ es: 'Hola', en: 'Hi' }, 'en', 'es'), 'Hi');
    assert.equal(pick({ es: 'Hola' }, 'en', 'es'), 'Hola');
    assert.equal(pick({ ca: 'Hola' }, 'en', 'es'), 'Hola');
    assert.equal(pick(undefined, 'en', 'es'), '');
  });

  test('the menú del día is on only when active, in its dates and on its weekdays', () => {
    const base = { active: true, days: [], from: '', to: '' };
    assert.equal(dailyIsOn(base, '2026-10-06'), true);
    assert.equal(dailyIsOn({ ...base, active: false }, '2026-10-06'), false);
    assert.equal(dailyIsOn({ ...base, from: '2026-10-07' }, '2026-10-06'), false);
    assert.equal(dailyIsOn({ ...base, to: '2026-10-05' }, '2026-10-06'), false);
    // 2026-10-06 is a Tuesday (2), 2026-10-10 a Saturday (6)
    assert.equal(dailyIsOn({ ...base, days: [1, 2, 3, 4, 5] }, '2026-10-06'), true);
    assert.equal(dailyIsOn({ ...base, days: [1, 2, 3, 4, 5] }, '2026-10-10'), false);
    assert.equal(dailyIsOn(null, '2026-10-06'), false);
  });
});

describe('menu photos', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]);

  test('the type comes from the bytes, not from what the file says', () => {
    assert.equal(photos.detectImage(jpeg).ext, 'jpg');
    assert.equal(photos.detectImage(png).ext, 'png');
    assert.equal(photos.detectImage(webp).ext, 'webp');
    assert.equal(photos.detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(photos.detectImage(Buffer.from('%PDF-1.7 not a photo at all')), null);
  });

  test('a key is a new one per upload and refuses odd identifiers', () => {
    const a = photos.makeKey('abc123', 'item1', 'jpg');
    const b = photos.makeKey('abc123', 'item1', 'jpg');
    assert.notEqual(a, b);
    assert.match(a, /^abc123\/item1-[0-9a-f]{12}\.jpg$/);
    assert.throws(() => photos.makeKey('../x', 'item1', 'jpg'), /no válido/);
  });

  test('local provider: store, serve, remove and purge a business', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-photos-'));
    process.env.MENU_STORAGE_DIR = dir;
    process.env.BACKEND_URL = 'https://api.example.test';
    photos.setProviderForTests(undefined);
    process.env.MENU_STORAGE_PROVIDER = 'local';
    try {
      const key = photos.makeKey('biz1', 'it1', 'png');
      const url = await photos.store({ key, buffer: png, mime: 'image/png' });
      assert.equal(url, `https://api.example.test/api/menu/public/photos/${key}`);
      const [biz, file] = key.split('/');
      const served = await photos.open(`${biz}/${file}`);
      assert.ok(served);
      served.stream.destroy();
      await photos.remove(key);
      assert.equal(await photos.open(`${biz}/${file}`), null);
      const other = photos.makeKey('biz1', 'it2', 'jpg');
      await photos.store({ key: other, buffer: jpeg, mime: 'image/jpeg' });
      await photos.removeBusiness('biz1');
      assert.equal(fs.existsSync(path.join(dir, 'biz1')), false);
      await assert.rejects(() => photos.open('biz1/../../etc.jpg'));
    } finally {
      photos.setProviderForTests(undefined);
      delete process.env.MENU_STORAGE_DIR;
      delete process.env.MENU_STORAGE_PROVIDER;
      delete process.env.BACKEND_URL;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('menu validation: menú del día', () => {
  const ok = {
    active: true, price: 14.5, days: [1, 2, 3, 4, 5], from: '2026-10-05', to: '2026-10-09',
    title: { es: 'Menú del día' }, includes: { es: 'Pan y bebida' },
    courses: [{ name: { es: 'Primeros' }, options: [{ name: { es: 'Lentejas' }, allergens: ['apio'] }, { name: { es: 'Ensalada' } }] }],
  };

  test('accepts a complete menu and keeps only what is valid', () => {
    const out = v.daily(ok, ['es', 'en']);
    assert.equal(out.price, 14.5);
    assert.deepEqual(out.days, [1, 2, 3, 4, 5]);
    assert.equal(out.courses[0].options.length, 2);
    assert.deepEqual(out.courses[0].options[1].allergens, []);
  });

  test('refuses bad dates, days, courses and allergens', () => {
    assert.throws(() => v.daily({ ...ok, from: '2026-10-09', to: '2026-10-05' }, ['es']), /anterior/);
    assert.throws(() => v.daily({ ...ok, from: '05/10/2026' }, ['es']), /no es válida/);
    assert.throws(() => v.daily({ ...ok, days: [7] }, ['es']), /días/);
    assert.throws(() => v.daily({ ...ok, courses: [{ name: {}, options: [] }] }, ['es']), /obligatorio/);
    assert.throws(() => v.daily({ ...ok, courses: Array.from({ length: 7 }, () => ({ name: { es: 'x' }, options: [] })) }, ['es']), /6 apartados/);
    assert.throws(() => v.daily({ ...ok, courses: [{ name: { es: 'x' }, options: [{ name: { es: 'y' }, allergens: ['polvo'] }] }] }, ['es']), /alérgenos/);
  });
});
