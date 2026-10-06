/**
 * End-to-end tests (HTTP API + a real MongoDB-compatible database) of the menu (carta):
 * categories and dishes, languages, the price lock of dishes that come from the POS and the import.
 * Skipped unless MONGO_TEST_URI is set (see reservations.db.test.js).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('menu (carta)', { skip }, () => {
  let app, mongoose, biz;
  const as = (user) => ({ 'x-test-user': user });

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_menu_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    const Business = require(path.join(ROOT, 'core/models/Business'));
    const BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    biz = await Business.create({ name: 'Bar Test', email: 'b@example.test', plan: 'pro', subscriptionStatus: 'active', businessType: 'restaurant', address: 'Calle 1' });
    for (const [id, role] of [['owner', 'owner'], ['staff', 'staff']]) {
      addUser({ id });
      await BusinessMember.create({ userId: id, businessId: biz._id, role });
    }
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('languages, categories and dishes; staff can only mark sold out', async () => {
    let res = await request(app).put('/api/menu/settings').set(as('owner')).send({ languages: ['es', 'en'] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await request(app).post('/api/menu/categories').set(as('owner')).send({ name: { es: 'Entrantes', en: 'Starters' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const cat = res.body._id;
    res = await request(app).post('/api/menu/items').set(as('owner')).send({ categoryId: cat, name: { es: 'Croquetas' }, price: 8, allergens: ['gluten', 'lacteos'] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const item = res.body._id;
    assert.equal((await request(app).post('/api/menu/items').set(as('staff')).send({ categoryId: cat, name: { es: 'X' } })).status, 403);
    res = await request(app).patch(`/api/menu/items/${item}/sold-out`).set(as('staff')).send({ soldOut: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.soldOut, true);
    res = await request(app).get('/api/menu').set(as('staff'));
    assert.deepEqual(res.body.languages, ['es', 'en']);
    assert.equal(res.body.items.length, 1);
    // A category with dishes cannot be deleted
    assert.equal((await request(app).delete(`/api/menu/categories/${cat}`).set(as('owner'))).status, 409);
  });

  test('import: preview, apply, price lock, a changed price and the dish that disappears', async () => {
    const rows = [
      { externalId: '1', category: 'Principales', name: 'Entrecot', price: 22 },
      { externalId: '2', category: 'Principales', name: 'Merluza', price: 18 },
    ];
    let res = await request(app).post('/api/menu/import').set(as('owner')).send({ rows });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.applied, false);
    assert.equal(res.body.summary.new, 2);
    res = await request(app).post('/api/menu/import').set(as('owner')).send({ rows, apply: true });
    assert.equal(res.body.applied, true);
    let menu = (await request(app).get('/api/menu').set(as('owner'))).body;
    const entrecot = menu.items.find((i) => i.name.es === 'Entrecot');
    assert.equal(entrecot.priceSource, 'tpv');
    assert.equal(entrecot.price, 22);
    // The price of an imported dish cannot be edited here, the rest can
    res = await request(app).put(`/api/menu/items/${entrecot._id}`).set(as('owner')).send({ price: 25 });
    assert.equal(res.status, 409);
    res = await request(app).put(`/api/menu/items/${entrecot._id}`).set(as('owner')).send({ description: { es: 'Con patatas' }, tags: ['recomendado'] });
    assert.equal(res.status, 200);
    // The TPV raises the price and drops the hake
    res = await request(app).post('/api/menu/import').set(as('owner')).send({ rows: [{ externalId: '1', category: 'Principales', name: 'Entrecot', price: 24 }], apply: true, retireMissing: true });
    assert.equal(res.body.summary.price, 1);
    assert.equal(res.body.summary.missing, 1);
    menu = (await request(app).get('/api/menu').set(as('owner'))).body;
    assert.equal(menu.items.find((i) => i.name.es === 'Entrecot').price, 24);
    assert.equal(menu.items.find((i) => i.name.es === 'Entrecot').description.es, 'Con patatas');
    assert.equal(menu.items.find((i) => i.name.es === 'Merluza').retired, true);
  });
  test('public menu: only what is shown, in the language asked, with the menú del día of today', async () => {
    const menu = (await request(app).get('/api/menu').set(as('owner'))).body;
    const hiddenCat = (await request(app).post('/api/menu/categories').set(as('owner')).send({ name: { es: 'Secreta' }, hidden: true })).body;
    await request(app).post('/api/menu/items').set(as('owner')).send({ categoryId: hiddenCat._id, name: { es: 'No se ve' }, price: 1 });
    const entrecot = menu.items.find((i) => i.name.es === 'Entrecot');
    await request(app).put(`/api/menu/items/${entrecot._id}`).set(as('owner')).send({ name: { es: 'Entrecot', en: 'Ribeye' } });
    let res = await request(app).put('/api/menu/daily').set(as('owner')).send({
      active: true, price: 14, title: { es: 'Menú del día' },
      courses: [{ name: { es: 'Primeros' }, options: [{ name: { es: 'Lentejas' }, allergens: ['apio'] }] }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    res = await request(app).get(`/api/menu/public/${biz._id}?lang=en`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.language, 'en');
    const names = res.body.categories.flatMap((c) => c.items.map((i) => i.name));
    assert.ok(names.includes('Ribeye'));
    assert.ok(!names.includes('No se ve'));
    assert.ok(!names.includes('Merluza'), 'retired dishes are not shown');
    assert.equal(res.body.daily.price, 14);
    // An unknown language falls back to the main one; an unknown business is a 404
    assert.equal((await request(app).get(`/api/menu/public/${biz._id}?lang=xx`)).body.language, 'es');
    assert.equal((await request(app).get('/api/menu/public/64b7f0f0f0f0f0f0f0f0f0f0')).status, 404);
  });

  test('photo: upload, replace and delete', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
    process.env.MENU_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-it-'));
    process.env.MENU_STORAGE_PROVIDER = 'local';
    require('../../modules/menu/services/photoStorage').setProviderForTests(undefined);
    const menu = (await request(app).get('/api/menu').set(as('owner'))).body;
    const item = menu.items.find((i) => i.name.es === 'Entrecot')._id;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    let res = await request(app).post(`/api/menu/items/${item}/photo`).set(as('owner')).attach('photo', png, { filename: 'a.png', contentType: 'image/png' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const first = res.body.photo.url;
    // Not an image, whatever it claims to be
    res = await request(app).post(`/api/menu/items/${item}/photo`).set(as('owner')).attach('photo', Buffer.from('hola mundo, esto no es una foto'), { filename: 'a.png', contentType: 'image/png' });
    assert.equal(res.status, 400);
    res = await request(app).post(`/api/menu/items/${item}/photo`).set(as('owner')).attach('photo', png, { filename: 'b.png', contentType: 'image/png' });
    assert.notEqual(res.body.photo.url, first);
    assert.equal((await request(app).post(`/api/menu/items/${item}/photo`).set(as('staff')).attach('photo', png, { filename: 'c.png', contentType: 'image/png' })).status, 403);
    res = await request(app).delete(`/api/menu/items/${item}/photo`).set(as('owner'));
    assert.equal(res.body.photo, undefined);
  });
});
