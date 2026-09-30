/**
 * Public addresses by slug: assigned on creation, backfilled, looked up by
 * current or old slug, edited with validation. Skipped unless MONGO_TEST_URI.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { installFakeAuth, addUser } = require('../helpers/fakeAuth');
const { ROOT } = require('../helpers/load');

const URI = process.env.MONGO_TEST_URI;
const skip = !URI && 'set MONGO_TEST_URI to run database tests';

describe('business public address (slug)', { skip }, () => {
  let app, mongoose, Business, BusinessMember;
  const as = (user, biz) => ({ 'x-test-user': user, 'x-business-id': String(biz) });

  before(async () => {
    installFakeAuth();
    mongoose = require('mongoose');
    await mongoose.connect(URI, { dbName: `vetra_slugs_${Date.now()}` });
    const mod = require('../../app');
    mod.mountAuthAndErrorHandlers((req, res) => res.status(418).end());
    app = mod.app;
    Business = require(path.join(ROOT, 'core/models/Business'));
    BusinessMember = require(path.join(ROOT, 'core/models/BusinessMember'));
    await Business.syncIndexes();
  });

  after(async () => {
    if (mongoose?.connection?.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('new businesses get a unique slug from their name', async () => {
    const a = await Business.create({ name: 'Estética Són', email: 'a@son.test', businessType: 'appointments' });
    const b = await Business.create({ name: 'Estetica Son', email: 'b@son.test', businessType: 'appointments' });
    const c = await Business.create({ name: 'Contact', email: 'c@son.test' });
    assert.equal(a.slug, 'estetica-son');
    assert.equal(b.slug, 'estetica-son-2');
    assert.equal(c.slug, 'contact-2', 'reserved words are skipped');
  });

  test('businesses created before slugs existed are backfilled', async () => {
    await Business.collection.insertOne({ name: 'Bar Pepe', email: 'pepe@bar.test', businessType: 'restaurant', slugHistory: [] });
    const { ensureBusinessSlugs } = require(path.join(ROOT, 'core/services/businessSlugs'));
    assert.equal(await ensureBusinessSlugs({ log: {} }), 1);
    assert.equal((await Business.findOne({ email: 'pepe@bar.test' }).lean()).slug, 'bar-pepe');
    assert.equal(await ensureBusinessSlugs({ log: {} }), 0, 'idempotent');
  });

  test('public lookup by slug; editing keeps the old address working', async () => {
    const biz = await Business.findOne({ slug: 'estetica-son' });
    await BusinessMember.create({ userId: 'sonOwner', businessId: biz._id, role: 'owner' });
    addUser({ id: 'sonOwner', email: 'owner@son.test' });

    let res = await request(app).get('/api/auth/public/business-by-slug/estetica-son');
    assert.equal(res.status, 200);
    assert.deepEqual([String(res.body.id), res.body.slug, res.body.businessType], [String(biz._id), 'estetica-son', 'appointments']);
    assert.equal(res.headers['access-control-allow-origin'], '*', 'callable from vetrareserve.com');
    assert.equal((await request(app).get('/api/auth/public/business-by-slug/no-existe')).status, 404);

    const put = (slug) => request(app).put('/api/auth/settings').set(as('sonOwner', biz._id)).send({ slug });
    assert.equal((await put('Hola Mundo')).status, 400, 'format');
    assert.equal((await put('precios')).body.code, 'SLUG_RESERVED');
    assert.equal((await put('estetica-son-2')).status, 409, 'taken by another business');
    res = await put('Son-Estetica');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.slug, 'son-estetica');
    assert.match(res.body.publicUrl, /\/son-estetica$/);

    res = await request(app).get('/api/auth/public/business-by-slug/estetica-son');
    assert.equal(res.status, 200, 'old slug still resolves');
    assert.equal(res.body.slug, 'son-estetica', 'and tells the page the current one');

    const other = await Business.findOne({ slug: 'estetica-son-2' });
    await BusinessMember.create({ userId: 'otherOwner', businessId: other._id, role: 'owner' });
    addUser({ id: 'otherOwner', email: 'owner@other.test' });
    res = await request(app).put('/api/auth/settings').set(as('otherOwner', other._id)).send({ slug: 'estetica-son' });
    assert.equal(res.status, 409, 'an old slug is never handed to another business');

    assert.equal((await put('estetica-son')).status, 200, 'the owner can go back to its old slug');
    const back = await Business.findById(biz._id).lean();
    assert.equal(back.slug, 'estetica-son');
    assert.deepEqual(back.slugHistory, ['son-estetica']);
  });

  test('public business data and emails use the new address', async () => {
    const biz = await Business.findOne({ slug: 'estetica-son' }).lean();
    const res = await request(app).get(`/api/auth/public/business/${biz._id}`);
    assert.equal(res.body.slug, 'estetica-son');
    const { publicBookingUrl } = require(path.join(ROOT, 'core/lib/publicUrls'));
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://app.vetrareserve.com';
    try {
      assert.equal(publicBookingUrl(biz), 'https://vetrareserve.com/estetica-son');
      assert.equal(publicBookingUrl({ _id: 'x1', businessType: 'appointments' }), 'https://app.vetrareserve.com/public/x1/cita', 'no slug: old address');
    } finally { process.env.FRONTEND_URL = prev; }
    assert.equal(publicBookingUrl(biz), 'http://localhost:3005/r/estetica-son', 'dev/local: the app serves /r/{slug}');
  });
});
